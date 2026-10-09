#!/usr/bin/env node
// handide proxy: sits in front of the editor's own `serve-web` and injects the mobile layer.
//
//   phone ──http/ws──> proxy (:9000) ──> serve-web (127.0.0.1 only)
//
// serve-web only accepts `Host: localhost:*` and bakes the host it sees into the page
// (remoteAuthority, CSP). So upstream requests are sent as localhost, and the
// responses are rewritten back to whatever host the phone used.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, stat, mkdir, copyFile, access, cp, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectEditorCli, editorVersion, startServeWeb } from './editor.mjs';
import { ensureCert, lanAddresses } from './tls.mjs';
import { accessInfo, isConnectAllowed, renderConnectPage } from './connect.mjs';
import { PHONE_APP_URL, openBrowser, setupRemote, startTailscale } from './tailscale.mjs';
import { startCloudflare } from './cloudflare.mjs';
import { createBridge } from './bridge.mjs';
import { createPortForwarder } from './ports.mjs';
import { importDesktopExtensions, removeImportedExtensions } from './extensions.mjs';
import { createDeviceRouter, devicesCommand } from './devices.mjs';
import QRCode from 'qrcode';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAYER_DIR = join(ROOT, 'layer');
const PROFILE_DIR = join(ROOT, 'profile');
const LAYER_PREFIX = '/__handide/';
// Personal layer config; --config points elsewhere (the automated check uses this).
let CONFIG_PATH = join(ROOT, 'layer.config.json');
// PC-side page with a large QR code; filled in once the server is listening.
const CONNECT_PATH = '/__handide/connect';
let CONNECT = null;

async function serveConnect(req, res) {
	const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
	if (!isConnectAllowed(req)) {
		res.writeHead(403, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
		res.end('This page is only available on the PC running handide: http://localhost:<port>/__handide/connect');
		return;
	}
	if (!CONNECT) {
		res.writeHead(503, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' });
		res.end('handide is still starting, reload in a moment.');
		return;
	}
	res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
	res.end(await renderConnectPage(CONNECT.info, CONNECT));
}

const isConnectRequest = (req) => req.method === 'GET' && req.url.split('?')[0] === CONNECT_PATH;

const MIME = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
};

// Per-user home, like other editors keep theirs (~/.vscode, ~/.cursor): mobile profile,
// extension, certificate, token and personal layout. HANDIDE_HOME overrides it.
const HOME_DIR = process.env.HANDIDE_HOME || join(os.homedir(), '.handide');
const LEGACY_DATA_DIR = join(ROOT, '.handide-data'); // before handide became a global command

const USAGE = `handide — your VS Code on your phone

Usage:  handide [folder] [options]      (folder defaults to the current directory)
        handide remote [--private]      one-time setup to use it away from home (Tailscale)
        handide devices add <name> <link>
                                        add another PC running handide (its printed link);
                                        the phone then switches PCs in the menu
        handide devices [remove <name>] list (with online state) or remove those PCs

  (default)           open on the LAN with HTTPS and print a QR code + link for the phone
  --local             this PC only (http://localhost), no LAN, no certificate
  --port <n>          port (default 9000)
  --host <addr>       listen address (default 0.0.0.0, or 127.0.0.1 with --local)
  --new-token         issue a new access token (old phone links stop working)
  --token <secret>    use this access token (default: kept in the handide home, or $HANDIDE_TOKEN)
  --editor <path>     editor CLI with serve-web (default: auto-detect VS Code)
  --private           away-from-home link only for devices signed in to your tailnet
                      (default: public Tailscale Funnel link, guarded by the access token)
  --cloudflare        away-from-home link without any account (Cloudflare Quick Tunnel;
                      a new random address on every run)
  --no-remote         no away-from-home link, LAN only
  --cert <file> --key <file>  serve HTTPS with your own certificate (e.g. from "tailscale cert")
  --data-dir <path>   handide home (default ~/.handide, or $HANDIDE_HOME)
  --config <path>     layout config (default <handide home>/layer.config.json)
  --open              open the connect page (large QR code) in this PC's browser
  --reset-profile     overwrite the mobile VS Code settings with handide's defaults
  --upstream <port>   use an already running serve-web on localhost:<port>

Phones need a secure context (https, or localhost): VS Code refuses to connect
over plain http://<LAN-IP>. The default LAN mode takes care of that. Other ways:
  Android over USB:  handide --local, then adb reverse tcp:9000 tcp:9000 and open http://localhost:9000
  Anywhere:          run "handide remote" once (Tailscale on this PC); handide then publishes
                     a fixed https://<machine>.<tailnet>.ts.net by itself, nothing to install
                     on the phone. No account at all: handide --cloudflare.
`;

function parseArgs(argv) {
	const opts = {
		port: 9000,
		host: undefined, // default: LAN with automatic HTTPS; --local: this PC only
		local: false,
		folder: process.cwd(),
		dataDir: undefined,
		token: undefined,
		newToken: false,
		editor: undefined,
		upstream: undefined,
		resetProfile: false,
		config: undefined,
		cert: undefined,
		key: undefined,
		remote: 'tailscale', // 'tailscale' | 'private' | 'cloudflare' | 'off'
		open: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--port') opts.port = Number(next());
		else if (a === '--host') opts.host = next();
		else if (a === '--local') opts.local = true;
		else if (a === '--folder') opts.folder = resolve(next());
		else if (a === '--data-dir') opts.dataDir = resolve(next());
		else if (a === '--token') opts.token = next();
		else if (a === '--new-token') opts.newToken = true;
		else if (a === '--editor') opts.editor = next();
		else if (a === '--upstream') opts.upstream = Number(next());
		else if (a === '--reset-profile') opts.resetProfile = true;
		else if (a === '--open') opts.open = true;
		else if (a === '--config') opts.config = resolve(next());
		else if (a === '--cert') opts.cert = resolve(next());
		else if (a === '--key') opts.key = resolve(next());
		else if (a === '--private') opts.remote = 'private';
		else if (a === '--cloudflare') opts.remote = 'cloudflare';
		else if (a === '--no-remote' || a === '--no-tailscale') opts.remote = 'off';
		else if (a === '-h' || a === '--help') {
			console.log(USAGE);
			process.exit(0);
		} else if (!a.startsWith('-')) opts.folder = resolve(a);
		else {
			console.error(`unknown option ${a}

${USAGE}`);
			process.exit(2);
		}
	}
	return opts;
}

/** Fills in the per-user defaults: handide home, persistent token, personal layout config. */
async function resolveHome(opts) {
	if (!opts.dataDir) {
		const useLegacy = !existsSync(HOME_DIR) && existsSync(LEGACY_DATA_DIR);
		opts.dataDir = useLegacy ? LEGACY_DATA_DIR : HOME_DIR;
	}
	await mkdir(opts.dataDir, { recursive: true });

	// The token is kept so links saved on the phone keep working across restarts.
	const tokenFile = join(opts.dataDir, 'token');
	if (!opts.token) opts.token = process.env.HANDIDE_TOKEN;
	if (!opts.token && !opts.newToken) opts.token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim() || undefined;
	if (!opts.token) {
		opts.token = randomBytes(18).toString('base64url');
		await writeFile(tokenFile, `${opts.token}\n`, { mode: 0o600 });
	}

	// Personal layout: created from handide's defaults on first run, then it is the user's.
	if (!opts.config) {
		opts.config = join(opts.dataDir, 'layer.config.json');
		if (!existsSync(opts.config)) await copyFile(join(ROOT, 'layer.config.json'), opts.config);
	}
}

/** Parses VS Code's JSON-with-comments files (comments and trailing commas). */
export function parseJsonc(text) {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
			out += text.slice(start, i + 1);
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
		} else if (c === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i + 2);
			if (i < 0) break;
			i++;
		} else out += c;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Keybindings the layer dispatches, generated from layer/commands.json. */
export async function layerKeybindings() {
	const { modifiers, tabs, actions } = JSON.parse(await readFile(join(LAYER_DIR, 'commands.json'), 'utf8'));
	const chord = (key) => `${modifiers}+${key.toLowerCase()}`;
	const tabBindings = Object.entries(tabs).map(([tab, key]) => ({ key: chord(key), command: 'handide.tab', args: { tab } }));
	const actionBindings = Object.values(actions)
		.filter(({ key }) => key)
		.map(({ key, command }) => ({ key: chord(key), command }));
	return [...tabBindings, ...actionBindings];
}

/**
 * Seeds the private data dir with the mobile profile.
 *
 * In serve-web, *user* settings and keybindings live in the browser (IndexedDB), so
 * the server-side User/ folder is ignored. What the server does read:
 *  - data/Machine/settings.json ("Remote" settings) → the mobile settings.
 *    Copied once, then it is the user's, unless --reset-profile.
 *  - installed extensions → the companion extension contributes the layer keybindings
 *    plus the user's extras from profile/keybindings.json; the desktop editors'
 *    extensions are linked in (proxy/extensions.mjs) unless importExtensions is false.
 */
async function seedProfile(dataDir, reset, log) {
	const machineDir = join(dataDir, 'data', 'Machine');
	await mkdir(machineDir, { recursive: true });
	const settings = join(machineDir, 'settings.json');
	const hasSettings = await access(settings).then(() => true, () => false);
	if (!hasSettings || reset) await copyFile(join(PROFILE_DIR, 'settings.json'), settings);
	else await addNewProfileSettings(settings);

	const config = parseJsonc(await readFile(CONFIG_PATH, 'utf8'));
	if (config.companion?.mode === 'builtin') await uninstallCompanion(dataDir);
	else await installCompanion(dataDir);

	const extDir = join(dataDir, 'extensions');
	if (config.importExtensions === false) return removeImportedExtensions(extDir);
	try {
		const imported = await importDesktopExtensions(extDir, { skipIds: [await companionId()] });
		for (const [source, ids] of Object.entries(imported)) log(`extensions from ${source}: ${ids.join(', ')}`);
	} catch (err) {
		log(`could not bring in desktop extensions: ${err.message}`);
	}
}

async function companionId() {
	const { publisher, name } = JSON.parse(await readFile(join(ROOT, 'extension', 'package.json'), 'utf8'));
	return `${publisher}.${name}`;
}

/** builtin mode: the layer uses VS Code's default shortcuts, so the companion is removed. */
async function uninstallCompanion(dataDir) {
	const registryPath = join(dataDir, 'extensions', 'extensions.json');
	const registry = await readFile(registryPath, 'utf8').then(JSON.parse, () => null);
	if (!registry) return;
	const id = (await companionId()).toLowerCase();
	const keep = registry.filter((e) => e.identifier?.id?.toLowerCase() !== id);
	if (keep.length !== registry.length) await writeFile(registryPath, JSON.stringify(keep));
}

/** Adds settings introduced in newer handide profiles; values the user already has are kept. */
async function addNewProfileSettings(settingsPath) {
	const profile = parseJsonc(await readFile(join(PROFILE_DIR, 'settings.json'), 'utf8'));
	const current = parseJsonc(await readFile(settingsPath, 'utf8'));
	let changed = false;
	// Defaults handide itself changed: replaced only while the user still has the old default.
	const UPGRADES = [['workbench.editor.showTabs', 'single'], ['workbench.editor.showTabs', 'none']];
	for (const [key, oldDefault] of UPGRADES) {
		if (current[key] === oldDefault && profile[key] !== undefined && profile[key] !== oldDefault) {
			current[key] = profile[key];
			changed = true;
		}
	}
	for (const [k, v] of Object.entries(profile)) {
		if (!(k in current)) {
			current[k] = v;
			changed = true;
		} else if (Array.isArray(v) && Array.isArray(current[k])) {
			// List settings (e.g. commandsToSkipShell): add new entries, keep the user's.
			const added = v.filter((x) => !current[k].includes(x));
			if (added.length) {
				current[k] = [...current[k], ...added];
				changed = true;
			}
		}
	}
	if (!changed) return;
	const header = '// handide mobile settings (Remote settings of the handide VS Code). Edit freely.\n';
	await writeFile(settingsPath, header + JSON.stringify(current, null, 2) + '\n');
}

/** Installs extension/ into the private extensions dir, with generated keybindings. */
async function installCompanion(dataDir) {
	const src = join(ROOT, 'extension');
	const manifest = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'));
	const layer = await layerKeybindings();
	const layerKeys = new Set(layer.map((b) => b.key));
	const extras = parseJsonc(await readFile(join(PROFILE_DIR, 'keybindings.json'), 'utf8')).filter((b) => !layerKeys.has(b.key));
	manifest.contributes = { ...manifest.contributes, keybindings: [...extras, ...layer] };

	const extDir = join(dataDir, 'extensions');
	const id = `${manifest.publisher}.${manifest.name}`;
	const folder = `${id}-${manifest.version}`;
	const dest = join(extDir, folder);
	await rm(dest, { recursive: true, force: true });
	await cp(src, dest, { recursive: true, filter: (p) => !p.includes(`${sep}node_modules`) });
	await writeFile(join(dest, 'package.json'), JSON.stringify(manifest, null, '\t') + '\n');

	// The server only loads extensions listed in its registry.
	const registryPath = join(extDir, 'extensions.json');
	const registry = await readFile(registryPath, 'utf8').then(JSON.parse, () => []);
	const fileUrl = pathToFileURL(dest);
	const entry = {
		identifier: { id },
		version: manifest.version,
		location: { $mid: 1, fsPath: dest, path: fileUrl.pathname, scheme: 'file' },
		relativeLocation: folder,
		metadata: { installedTimestamp: Date.now(), source: 'vsix', pinned: true },
	};
	const others = registry.filter((e) => e.identifier?.id?.toLowerCase() !== id.toLowerCase());
	await writeFile(registryPath, JSON.stringify([...others, entry]));
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolvePort(port));
		});
		srv.on('error', reject);
	});
}

async function layerVersion() {
	const hash = createHash('sha1');
	for (const f of ['mobile.css', 'mobile.js', 'selectors.json', 'commands.json']) {
		const s = await stat(join(LAYER_DIR, f)).catch(() => null);
		hash.update(`${f}:${s?.mtimeMs ?? 0}`);
	}
	return hash.digest('hex').slice(0, 10);
}

async function serveLayer(req, res) {
	const url = new URL(req.url, 'http://x');
	const rel = decodeURIComponent(url.pathname.slice(LAYER_PREFIX.length));
	// config.json lives at the repo root so users (and the skill) edit one obvious file.
	const file = rel === 'config.json' ? CONFIG_PATH : normalize(join(LAYER_DIR, rel));
	if (rel !== 'config.json' && !file.startsWith(LAYER_DIR + sep)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const body = await readFile(file);
		res.writeHead(200, {
			'content-type': MIME[extname(file)] || 'application/octet-stream',
			'cache-control': 'no-cache',
		});
		res.end(body);
	} catch {
		res.writeHead(404).end();
	}
}

// Restricted Mode turns every extension off, the companion included, which leaves the
// phone without its layout and agents. The trust prompt is per browser, so it would
// come back on every new phone or browser; the access token already guards the server.
async function workspaceTrustWanted() {
	const config = await readFile(CONFIG_PATH, 'utf8').then(parseJsonc, () => ({}));
	return config.workspaceTrust === true;
}

function disableWorkspaceTrust(html) {
	return html.replace(/(&quot;|")enableWorkspaceTrust\1:true/, '$1enableWorkspaceTrust$1:false');
}

function injectLayer(html, version) {
	const css = `<link rel="stylesheet" href="${LAYER_PREFIX}mobile.css?v=${version}">`;
	const js = `<script type="module" src="${LAYER_PREFIX}mobile.js?v=${version}"></script>`;
	const withCss = html.includes('</head>') ? html.replace('</head>', `\t${css}\n\t</head>`) : css + html;
	return withCss.includes('</html>') ? withCss.replace('</html>', `${js}\n</html>`) : withCss + js;
}

function createProxy({ upstreamPort, log, tls, bridge, ports, devices }) {
	const upHost = `localhost:${upstreamPort}`;

	const clientBase = (req) => {
		const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
		return { host: req.headers.host || upHost, proto };
	};
	const toUpstreamHeaders = (req) => {
		const headers = { ...req.headers, host: upHost };
		if (headers.origin) headers.origin = `http://${upHost}`;
		if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, `http://${upHost}`);
		return headers;
	};

	const handler = async (req, res) => {
		if (isConnectRequest(req)) return serveConnect(req, res);
		// Another PC picked on the phone: everything else is that PC's (proxy/devices.mjs).
		if (devices?.handle(req, res, clientBase(req).proto)) return;
		const pathname = req.url.split('?')[0];
		// A tiny, disk-free reachability probe for mobile network transitions.
		if (pathname === `${LAYER_PREFIX}health`) {
			res.writeHead(204, { 'cache-control': 'no-store' });
			return res.end();
		}
		// localhost:<port> links opened on the phone (dev servers on the PC).
		if (ports?.handle(req, res)) return;
		if (bridge && (pathname.startsWith('/__handide/bridge/') || pathname === '/__handide/fs')) return bridge.handleLayer(req, res, pathname);
		if (req.url.startsWith(LAYER_PREFIX)) return serveLayer(req, res);

		const { host, proto } = clientBase(req);
		const headers = toUpstreamHeaders(req);
		const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
		if (wantsHtml) headers['accept-encoding'] = 'identity';

		const upReq = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, async (upRes) => {
			const out = { ...upRes.headers };
			const fixHost = (v) => v.replaceAll(`http://${upHost}`, `${proto}://${host}`).replaceAll(upHost, host);
			if (out.location) out.location = fixHost(out.location);
			if (out['content-security-policy']) {
				out['content-security-policy'] = [].concat(out['content-security-policy']).map(fixHost);
			}
			const isHtml = /text\/html/.test(out['content-type'] || '') && !out['content-encoding'];
			if (!isHtml) {
				res.writeHead(upRes.statusCode, out);
				upRes.pipe(res);
				return;
			}
			const chunks = [];
			for await (const c of upRes) chunks.push(c);
			let html = Buffer.concat(chunks).toString('utf8');
			html = html.replaceAll(upHost, host);
			if (upRes.statusCode === 200 && html.includes('vscode-workbench-web-configuration')) {
				if (!(await workspaceTrustWanted())) html = disableWorkspaceTrust(html);
				html = injectLayer(html, await layerVersion());
			}
			delete out['content-length'];
			delete out['transfer-encoding'];
			out['content-length'] = Buffer.byteLength(html);
			res.writeHead(upRes.statusCode, out);
			res.end(html);
		});
		upReq.on('error', (err) => {
			log(`upstream error: ${err.message}`);
			if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
			res.end('handide: editor server not reachable yet, retry in a few seconds.');
		});
		req.pipe(upReq);
	};
	const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

	// WebSockets (extension host, terminals, file system) are passed through byte for byte.
	server.on('upgrade', (req, socket, head) => {
		if (devices?.upgrade(req, socket, head, clientBase(req).proto)) return;
		if (ports?.upgrade(req, socket, head)) return;
		const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
			const headers = toUpstreamHeaders(req);
			const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
			for (const [k, v] of Object.entries(headers)) {
				for (const value of [].concat(v)) lines.push(`${k}: ${value}`);
			}
			upstream.write(lines.join('\r\n') + '\r\n\r\n');
			if (head?.length) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		const close = () => {
			upstream.destroy();
			socket.destroy();
		};
		upstream.on('error', close);
		socket.on('error', close);
		upstream.on('close', close);
		socket.on('close', close);
	});

	if (!tls) return server;

	// HTTPS and a redirect share one port: someone typing http://<ip>:<port> on the
	// phone is sent to https:// instead of getting a dead connection. A TLS handshake
	// starts with byte 0x16; anything else is plain HTTP.
	const redirect = http.createServer((req, res) => {
		// The connect page stays on plain http://localhost so the PC browser shows no certificate warning.
		if (isConnectRequest(req)) return serveConnect(req, res);
		res.writeHead(301, { location: `https://${req.headers.host}${req.url}` }).end();
	});
	return net.createServer((socket) => {
		socket.on('error', () => socket.destroy());
		socket.once('data', (first) => {
			socket.pause();
			socket.unshift(first);
			(first[0] === 0x16 ? server : redirect).emit('connection', socket);
			process.nextTick(() => socket.resume());
		});
	});
}

/**
 * Prints how to connect. On the LAN the phone scans the QR code (here, or larger on
 * the connect page); the link carries the token, which VS Code turns into a cookie.
 */
async function printAccess(info, { selfSigned, log }) {
	const page = `http://localhost:${info.port}${CONNECT_PATH}`;
	if (info.local && !info.links.length) {
		log(`  ${info.localUrl}`);
		log(`  Android over USB: adb reverse tcp:${info.port} tcp:${info.port}, then open the link above on the phone.`);
		log('  Drop --local to open it on the LAN with a QR code.');
		return;
	}
	if (!info.links.length) {
		log(`  No LAN address found. On this PC: ${info.localUrl}`);
		return;
	}
	const [primary, ...others] = info.links;
	const qr = await QRCode.toString(primary.url, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
	process.stdout.write(`
${qr}
`);
	log(`  Scan the QR code, or open: ${primary.url}`);
	if (primary.remote && !primary.public) log('  Works from anywhere while the Tailscale app is on (same account as this PC).');
	log(`  Large QR code in the PC browser: ${page}`);
	for (const o of others) log(`  also: ${o.url}   (${o.label}${primary.remote ? ', same Wi-Fi only' : ''})`);
	if (selfSigned && info.links.some((l) => !l.remote)) {
		log('  First visit shows a certificate warning (self-signed, made for this PC):');
		log('    Android Chrome: Advanced → Proceed.  iPhone Safari: Show Details → visit this website.');
		log(`    Certificate SHA-1: ${selfSigned}`);
	}
	log(primary.public
		? '  This link is public and its access token is the key: keep it to yourself (handide --new-token replaces it).'
		: '  The link contains the access token: share it only with your own devices.');
}

async function remoteCommand(log, tailnetOnly) {
	log('Setting up access from anywhere (Tailscale). Safe to rerun; finished steps are skipped.');
	if (!(await setupRemote({ log, private: tailnetOnly }))) process.exit(1);
	if (!tailnetOnly) {
		log('Done. Run "handide" as usual: its QR code works at home and outside, nothing to install on the phone.');
		log('(Only your own devices instead: "handide remote --private", then start with "handide --private".)');
		return;
	}
	const qr = await QRCode.toString(PHONE_APP_URL, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
	process.stdout.write(`\n${qr}\n`);
	log('Last step, on the phone: scan this QR code, install the Tailscale app,');
	log('sign in with the same account and turn it on.');
	log('Then run "handide --private": its QR code works at home and outside.');
}

async function main() {
	const log = (msg) => process.stdout.write(`[handide] ${String(msg).trimEnd()}\n`);
	if (process.argv[2] === 'remote') return remoteCommand(log, process.argv.includes('--private'));
	if (process.argv[2] === 'devices') {
		const args = process.argv.slice(3);
		const at = args.indexOf('--data-dir');
		const dataDir = at >= 0 ? resolve(args.splice(at, 2)[1]) : HOME_DIR;
		return devicesCommand(args, { dataDir, log });
	}
	const opts = parseArgs(process.argv.slice(2));
	await resolveHome(opts);
	CONFIG_PATH = opts.config;
	log(`folder: ${opts.folder}`);
	log(`handide home: ${opts.dataDir}${opts.dataDir === LEGACY_DATA_DIR ? ' (existing data from before the global command; move it to ~/.handide to switch)' : ''}`);
	let upstreamPort = opts.upstream;
	let child;
	const bridge = createBridge({ token: opts.token });
	const bridgeEnv = await bridge.listen();

	if (!upstreamPort) {
		const cli = detectEditorCli(opts.editor);
		log(`editor: ${cli} (${editorVersion(cli)})`);
		await seedProfile(opts.dataDir, opts.resetProfile, log);
		upstreamPort = await freePort();
		const started = startServeWeb({
			cli,
			port: upstreamPort,
			token: opts.token,
			dataDir: opts.dataDir,
			folder: opts.folder,
			env: bridgeEnv,
			log: (t) => { if (process.env.HANDIDE_VERBOSE) log(t); },
		});
		child = started.child;
		await started.ready;
	}

	const host = opts.host ?? (opts.local ? '127.0.0.1' : '0.0.0.0');
	const onlyLocal = host === '127.0.0.1' || host === 'localhost';
	let tls;
	let selfSigned;
	if (opts.cert && opts.key) tls = { cert: await readFile(opts.cert), key: await readFile(opts.key) };
	else if (!onlyLocal) {
		const cert = await ensureCert(opts.dataDir, lanAddresses().map((a) => a.ip));
		tls = { cert: cert.cert, key: cert.key };
		selfSigned = cert.fingerprint;
	}
	const ports = createPortForwarder({ token: opts.token, log });
	const devices = createDeviceRouter({ token: opts.token, dataDir: opts.dataDir, selfName: os.hostname(), log });
	await devices.refresh();
	if (devices.list().length) log(`other PCs (switch in the phone menu): ${devices.list().map((d) => d.name).join(', ')}`);
	const server = createProxy({ upstreamPort, log, tls, bridge, ports, devices });
	server.on('error', (err) => {
		if (err.code === 'EADDRINUSE') log(`port ${opts.port} is already in use (another handide?). Stop it or pass --port <n>.`);
		else log(`server error: ${err.message}`);
		process.exit(1); // the 'exit' handler stops the editor server
	});
	let stopRemote;
	const announce = (remote) => {
		CONNECT = { info: accessInfo({ host, port: opts.port, token: opts.token, tls, remote }), selfSigned };
		printAccess(CONNECT.info, { selfSigned, log }).catch((err) => log(`could not print access info: ${err.message}`));
	};
	// The connect page has no live updates, so it opens once the away-from-home link is settled.
	const openConnect = () => opts.open && openBrowser(`http://localhost:${opts.port}${CONNECT_PATH}`);
	server.listen(opts.port, host, async () => {
		log(`mobile VS Code ready. Open on your phone:`);
		announce();
		if (opts.remote === 'off') return openConnect();
		// Tunnels can wait for a one-time approval in the browser, so the LAN QR code comes first.
		const r = opts.remote === 'cloudflare'
			? { ...(await startCloudflare({ port: opts.port, tls, dataDir: opts.dataDir, log })), public: true, changes: true }
			: await startTailscale({ port: opts.port, tls, log, private: opts.remote === 'private' });
		if (r.url) {
			stopRemote = r.stop;
			log(r.public
				? `Reachable from anywhere, no app needed on the phone${r.changes ? ' (this address changes on every run)' : ''}. Open on your phone:`
				: 'Reachable from anywhere by devices on your tailnet (Tailscale app on). Open on your phone:');
			announce({ url: r.url, public: r.public });
		} else if (r.reason === 'not installed') {
			log('To use it away from home too: run "handide remote" once, or start with --cloudflare (no account).');
		} else {
			log(`Away-from-home link not available (${r.reason})${r.hint ? `: ${r.hint.trim()}` : ''}`);
		}
		openConnect();
	});

	// serve-web spawns its own server process; kill the whole tree so nothing is orphaned.
	const killEditor = () => {
		if (!child || child.exitCode !== null) return;
		if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
		else child.kill('SIGTERM');
	};
	const cleanup = () => {
		killEditor();
		stopRemote?.();
		stopRemote = undefined;
	};
	const shutdown = () => {
		cleanup();
		server.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	process.on('SIGHUP', shutdown);
	process.on('exit', cleanup);
}

// Run when executed directly, including through the global `handide` link (a different
// path to the same file), but not when imported by the checks.
const invokedPath = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : null;
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
	main().catch((err) => {
		console.error(`[handide] ${err.message}`);
		process.exit(1);
	});
}
