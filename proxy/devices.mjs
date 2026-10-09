// Several PCs behind one phone link. The handide the phone opened (the hub) relays to
// handide running on the other PCs; the phone picks one in the menu and the choice is
// kept in a cookie, so every path the editor uses stays where it is.
//
//   phone ──> handide on PC A (hub) ──┬──> its own serve-web          (no cookie)
//                                      └──> handide on PC B ──> ...    (cookie: B)
//
// Each PC keeps its own access token and checks it itself: switching to a PC puts that
// PC's token in the phone's token cookie (the editor sends it inside its WebSocket
// protocol, so it cannot be swapped on the way). The hub's own token is kept aside to
// switch back, and switching needs it.
//
// PCs are added once with "handide devices add <name> <link>", the link the other PC
// prints. Its self-signed certificate is pinned then (trust on first use).
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEVICE_COOKIE = '__handide_device';
const TOKEN_COOKIE = 'vscode-tkn';
const HUB_COOKIE = '__handide_hub'; // this PC's token while the phone uses another PC
// This PC's own server-side cookies, never sent on to another PC.
const PRIVATE_COOKIES = new Set(['__handide_port', 'vscode-cli-secret-half']);
const LIST_PATH = '/__handide/devices';
const USE_PATH = '/__handide/devices/use';
const NAME = /^[A-Za-z0-9][\w.-]{0,31}$/;
const CERT_ERRORS = /SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|CERT_/;

const devicesFile = (dataDir) => join(dataDir, 'devices.json');

export async function loadDevices(dataDir) {
	const list = await readFile(devicesFile(dataDir), 'utf8').then(JSON.parse, () => []);
	return Array.isArray(list) ? list.filter((d) => d && NAME.test(d.name) && d.url && d.token) : [];
}

async function saveDevices(dataDir, list) {
	await writeFile(devicesFile(dataDir), JSON.stringify(list, null, '\t') + '\n', { mode: 0o600 });
}

const cookies = (req) => {
	const out = {};
	for (const part of (req.headers.cookie || '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k) out[k] = decodeURIComponent(v.join('='));
	}
	return out;
};

const normFingerprint = (fp) => String(fp || '').replace(/:/g, '').toLowerCase();

/** "https://192.168.0.5:9000/?tkn=…" (what handide prints) → { url: origin, token }. */
export function parseLink(link) {
	let url;
	try {
		url = new URL(link);
	} catch {
		throw new Error(`not a link: ${link}`);
	}
	if (!/^https?:$/.test(url.protocol)) throw new Error('the link must start with https:// (or http://)');
	const token = url.searchParams.get('tkn');
	if (!token) throw new Error('the link has no access token (?tkn=…): copy the full link the other PC shows');
	return { url: url.origin, token };
}

/**
 * A connected socket to the device: TLS with the pinned certificate, normal TLS
 * verification without a pin (e.g. a ts.net address), or plain TCP for http://.
 */
function connectDevice(device, { timeoutMs = 8000, insecure = false } = {}) {
	const url = new URL(device.url);
	const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
	const host = url.hostname.replace(/^\[|\]$/g, '');
	return new Promise((ok, fail) => {
		let settled = false;
		let socket;
		const done = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) {
				socket?.destroy();
				fail(err);
			} else ok(socket);
		};
		const timer = setTimeout(() => done(new Error(`${device.url} did not answer`)), timeoutMs);
		if (url.protocol === 'http:') {
			socket = net.connect(port, host, () => done());
		} else {
			const pinned = !!device.fingerprint;
			socket = tls.connect(
				{ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !pinned && !insecure, ALPNProtocols: ['http/1.1'] },
				() => {
					if (pinned && normFingerprint(socket.getPeerCertificate().fingerprint) !== normFingerprint(device.fingerprint)) {
						return done(new Error(`the certificate of "${device.name}" changed; run "handide devices add ${device.name} <link>" again with its new link`));
					}
					done();
				},
			);
		}
		socket.once('error', done);
	});
}

/** An http.Agent whose connections go through connectDevice (keep-alive: TLS is set up once). */
function deviceAgent(device, { keepAlive = false, ...opts } = {}) {
	const agent = new http.Agent({ keepAlive });
	agent.createConnection = (_o, cb) => {
		connectDevice(device, opts).then((s) => cb(null, s), cb);
	};
	return agent;
}

/** One small request to a device, for setup and status checks. */
function deviceRequest(device, path, { headers = {}, timeoutMs = 4000, insecure } = {}) {
	return new Promise((ok, fail) => {
		const req = http.request(
			{
				method: 'GET',
				path,
				headers: { host: new URL(device.url).host, ...headers },
				agent: deviceAgent(device, { timeoutMs, insecure }),
				setHost: false,
				timeout: timeoutMs,
			},
			(res) => {
				res.resume();
				res.on('end', () => ok({ status: res.statusCode }));
			},
		);
		req.on('timeout', () => req.destroy(new Error(`${device.url} did not answer`)));
		req.on('error', fail);
		req.end();
	});
}

/** The certificate a device presents (SHA-1, as handide prints it), without verifying it. */
function peekCertificate(device) {
	return connectDevice({ ...device, fingerprint: undefined }, { insecure: true }).then((socket) => {
		const fp = socket.getPeerCertificate().fingerprint;
		socket.destroy();
		return fp;
	});
}

/** Checks the link against the running handide on that PC and returns what to store. */
async function verifyDevice(name, link) {
	const device = { name, ...parseLink(link) };
	const probe = () => deviceRequest(device, '/__handide/bridge/status', { headers: { cookie: `${TOKEN_COOKIE}=${encodeURIComponent(device.token)}`, 'x-handide': '1' } });
	let r;
	try {
		r = await probe();
	} catch (err) {
		if (!CERT_ERRORS.test(err.code || err.message)) throw new Error(`could not reach ${device.url} (${err.message}). Is handide running on that PC, and is the link from it?`);
		// handide's own self-signed certificate: pin the one it shows now.
		device.fingerprint = await peekCertificate(device);
		r = await probe();
	}
	if (r.status === 403) throw new Error('that PC refused the access token: copy its current link again');
	if (r.status !== 200) throw new Error(`${device.url} does not look like handide (HTTP ${r.status})`);
	return device;
}

/** "handide devices [add <name> <link> | remove <name>]" */
export async function devicesCommand(args, { dataDir, log }) {
	const [sub, name, link] = args;
	const list = await loadDevices(dataDir);
	if (sub === 'add') {
		if (!name || !link) throw new Error('usage: handide devices add <name> <link from the other PC>');
		if (!NAME.test(name)) throw new Error('the name may use letters, digits, ".", "_" and "-" (up to 32)');
		const device = await verifyDevice(name, link);
		await saveDevices(dataDir, [...list.filter((d) => d.name !== name), device]);
		log(`added "${name}" (${device.url})${device.fingerprint ? `, certificate SHA-1 ${device.fingerprint}` : ''}`);
		if (device.fingerprint) log('  Compare it with the "Certificate SHA-1" that handide prints on that PC.');
		log('  Open the menu on the phone and pick it under PCs (reload the page if handide is already open).');
		return;
	}
	if (sub === 'remove' || sub === 'rm') {
		if (!list.some((d) => d.name === name)) throw new Error(`no device named "${name}"`);
		await saveDevices(dataDir, list.filter((d) => d.name !== name));
		log(`removed "${name}"`);
		return;
	}
	if (sub && sub !== 'list') throw new Error(`unknown devices command "${sub}" (add, remove, list)`);
	if (!list.length) {
		log('No other PCs yet. On the other PC run "handide", then here:');
		log('  handide devices add <name> "<the link it prints>"');
		return;
	}
	for (const d of list) {
		const online = await deviceRequest(d, '/__handide/health').then((r) => r.status === 204, () => false);
		log(`${d.name}  ${d.url}  ${online ? 'online' : 'offline'}`);
	}
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Routes the phone's requests to the PC it picked. handle()/upgrade() return false for
 * requests that stay on this PC.
 */
export function createDeviceRouter({ token, dataDir, selfName, log }) {
	let devices = [];
	let mtime = -1;
	const agents = new Map(); // name → keep-alive agent, replaced when the device is re-added
	const refresh = async () => {
		const m = await stat(devicesFile(dataDir)).then((s) => s.mtimeMs, () => 0);
		if (m === mtime) return;
		mtime = m;
		devices = await loadDevices(dataDir);
		for (const a of agents.values()) a.destroy();
		agents.clear();
		for (const d of devices) agents.set(d.name, deviceAgent(d, { keepAlive: true }));
	};

	const query = (req) => new URL(req.url, 'http://x').searchParams;
	/** Allowed to list and switch PCs: this PC's token, wherever the phone is now. */
	const authed = (req) => {
		const c = cookies(req);
		return c[HUB_COOKIE] === token || c[TOKEN_COOKIE] === token || query(req).get('tkn') === token;
	};
	const selected = (req) => {
		const name = cookies(req)[DEVICE_COOKIE];
		return name ? devices.find((d) => d.name === name) : undefined;
	};

	/** Cookies as the device should see them: its own (named back, see renameCookie), none of this PC's. */
	function deviceCookies(req, device) {
		const suffix = `.hd-${device.name}`;
		const out = [];
		for (const part of (req.headers.cookie || '').split(';')) {
			const c = part.trim();
			const name = c.split('=')[0];
			if (!c || name === DEVICE_COOKIE || name === HUB_COOKIE) continue;
			if (name.endsWith(suffix)) out.push(name.slice(0, -suffix.length) + c.slice(name.length));
			else if (!name.includes('.hd-') && !PRIVATE_COOKIES.has(name)) out.push(c);
		}
		return out.join('; ');
	}

	/**
	 * Server-only (HttpOnly) cookies are kept per device, so two PCs never overwrite each
	 * other's (VS Code's secret storage key half, the forwarded port). Cookies the page
	 * reads itself keep their name.
	 */
	const renameCookie = (setCookie, device) =>
		/;\s*httponly/i.test(setCookie) ? setCookie.replace(/^\s*([^=;\s]+)=/, `$1.hd-${device.name}=`) : setCookie;

	function deviceHeaders(req, device, proto) {
		const headers = { ...req.headers, 'x-forwarded-proto': proto };
		const cookie = deviceCookies(req, device);
		if (cookie) headers.cookie = cookie;
		else delete headers.cookie;
		return headers;
	}

	function sendPage(res, status, title, text, current) {
		const others = [{ name: '', label: selfName }, ...devices.map((d) => ({ name: d.name, label: d.name }))].filter((d) => d.name !== current);
		res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>handide</title>
<body style="font:16px/1.5 system-ui,sans-serif;padding:24px;max-width:36em;margin:auto"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${text}</p>
<p><a href="/">Retry</a></p><ul>${others.map((d) => `<li><a href="${USE_PATH}?id=${encodeURIComponent(d.name)}">Open ${escapeHtml(d.label)}</a></li>`).join('')}</ul></body>`);
	}

	async function list(req, res) {
		await refresh();
		const current = selected(req)?.name ?? '';
		const status = await Promise.all(
			devices.map((d) => deviceRequest(d, '/__handide/health', { timeoutMs: 2500 }).then((r) => r.status === 204, () => false)),
		);
		const body = {
			ok: true,
			current,
			devices: [{ id: '', name: selfName, online: true }, ...devices.map((d, i) => ({ id: d.name, name: d.name, online: status[i] }))],
		};
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
		res.end(JSON.stringify(body));
	}

	/**
	 * Plain navigation (works from any page, even another PC's older layer): pick a PC,
	 * open its editor. The editor reads its token from the vscode-tkn cookie and sends it
	 * inside its own WebSocket protocol, so the cookie must hold the picked PC's token;
	 * this PC's is kept aside (HttpOnly) for switching back.
	 */
	async function use(req, res) {
		await refresh();
		const id = query(req).get('id') || '';
		const device = devices.find((d) => d.name === id);
		if (id && !device) return sendPage(res, 404, 'Unknown PC', `No PC named <b>${escapeHtml(id)}</b> is set up here.`);
		const year = 'Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax';
		res.writeHead(302, {
			location: '/',
			'cache-control': 'no-store',
			'set-cookie': [
				device ? `${DEVICE_COOKIE}=${encodeURIComponent(device.name)}; ${year}` : `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
				`${HUB_COOKIE}=${encodeURIComponent(token)}; ${year}`,
				// Same lifetime as the editor's own token cookie.
				`${TOKEN_COOKIE}=${encodeURIComponent(device ? device.token : token)}; Path=/; Max-Age=604800; SameSite=Lax`,
			],
		});
		res.end();
	}

	function forward(req, res, device, proto) {
		const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
		const upReq = http.request(
			{ method: req.method, path: req.url, headers: deviceHeaders(req, device, proto), agent: agents.get(device.name), setHost: false },
			(upRes) => {
				const out = { ...upRes.headers };
				if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map((c) => renameCookie(c, device));
				res.writeHead(upRes.statusCode, out);
				upRes.pipe(res);
			},
		);
		upReq.on('error', (err) => {
			if (res.headersSent) return res.destroy();
			log(`${device.name}: ${err.message}`);
			if (wantsHtml) sendPage(res, 502, `${device.name} is not reachable`, `Start handide on that PC (and check it is on), then retry. (${escapeHtml(err.message)})`, device.name);
			else {
				res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(`handide: ${device.name} is not reachable`);
			}
		});
		req.pipe(upReq);
	}

	/** Handles the request if it is about devices or belongs to another PC. */
	function handle(req, res, proto) {
		const pathname = req.url.split('?')[0];
		if (pathname === LIST_PATH || pathname === USE_PATH) {
			if (!authed(req) || (pathname === LIST_PATH && req.headers['x-handide'] !== '1')) {
				res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
				return true;
			}
			(pathname === LIST_PATH ? list : use)(req, res).catch((err) => {
				if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(err.message);
			});
			return true;
		}
		const device = selected(req);
		// A page load whose token does not fit the PC it would reach (this PC's QR code
		// scanned while another PC is picked, or a PC that was removed): settle it first.
		const expected = device ? device.token : token;
		const wantsPage = req.method === 'GET' && pathname === '/' && (req.headers.accept || '').includes('text/html');
		if (wantsPage && cookies(req)[TOKEN_COOKIE] !== expected && query(req).get('tkn') !== expected && authed(req)) {
			const tkn = query(req).get('tkn') === token ? `&tkn=${encodeURIComponent(token)}` : '';
			res.writeHead(302, { location: `${USE_PATH}?id=${encodeURIComponent(device?.name ?? '')}${tkn}`, 'cache-control': 'no-store' });
			res.end();
			return true;
		}
		if (!device) return false;
		forward(req, res, device, proto);
		return true;
	}

	/** WebSockets (extension host, terminals) of another PC, passed through byte for byte. */
	function upgrade(req, socket, head, proto) {
		const device = selected(req);
		if (!device) return false;
		const headers = deviceHeaders(req, device, proto);
		connectDevice(device).then(
			(upstream) => {
				const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
				for (const [k, v] of Object.entries(headers)) for (const value of [].concat(v)) lines.push(`${k}: ${value}`);
				upstream.write(lines.join('\r\n') + '\r\n\r\n');
				if (head?.length) upstream.write(head);
				upstream.pipe(socket);
				socket.pipe(upstream);
				const close = () => {
					upstream.destroy();
					socket.destroy();
				};
				upstream.on('error', close);
				socket.on('error', close);
				upstream.on('close', close);
				socket.on('close', close);
			},
			(err) => {
				log(`${device.name}: ${err.message}`);
				socket.destroy();
			},
		);
		return true;
	}

	return { handle, upgrade, refresh, list: () => devices };
}
