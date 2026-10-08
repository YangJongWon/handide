// Command bridge: lets the mobile layer run official VS Code commands *with
// arguments* (open this file, open that folder), which keystrokes cannot do.
//
//   layer ──POST /__handide/bridge/call──> proxy ──long-poll──> companion extension
//         <────────── result ─────────────       <── POST result ──
//
// The extension reaches the proxy on a private 127.0.0.1 port with a per-run secret
// (passed as environment variables when the editor server starts), so it never deals
// with the phone-facing HTTPS certificate.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, parse as parsePath } from 'node:path';

const readBody = (req, limit = 1 << 20) =>
	new Promise((ok, fail) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > limit) {
				fail(new Error('body too large'));
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
		req.on('error', fail);
	});

const sendJson = (res, status, value) => {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(value));
};

const cookie = (req, name) => {
	for (const part of (req.headers.cookie || '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return decodeURIComponent(v.join('='));
	}
	return undefined;
};

export function createBridge({ token, log }) {
	const secret = randomBytes(24).toString('hex');
	const queue = []; // calls waiting for the extension
	const polls = []; // extension long-polls waiting for calls
	const inflight = new Map(); // id -> { resolve, timer }
	let lastPoll = 0;
	let seq = 0;

	const flush = () => {
		while (queue.length && polls.length) {
			const res = polls.shift();
			sendJson(res, 200, queue.splice(0, queue.length));
		}
	};

	function call(command, args = [], timeoutMs = 20_000) {
		const id = `${Date.now().toString(36)}-${++seq}`;
		return new Promise((resolveCall) => {
			const timer = setTimeout(() => {
				inflight.delete(id);
				resolveCall({ ok: false, error: extensionConnected() ? 'timed out' : 'companion extension not connected (is the folder trusted?)' });
			}, timeoutMs);
			inflight.set(id, { resolve: resolveCall, timer });
			queue.push({ id, command, args });
			flush();
		});
	}

	const extensionConnected = () => Date.now() - lastPoll < 35_000;

	/** Requests from the layer (phone). Authenticated like VS Code itself: the token cookie. */
	const allowed = (req) => cookie(req, 'vscode-tkn') === token && req.headers['x-handide'] === '1'; // custom header: no cross-site form/fetch

	async function handleLayer(req, res, pathname) {
		if (!allowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
		try {
			if (pathname === '/__handide/bridge/call' && req.method === 'POST') {
				// Phone screenshots are base64 in this JSON request (15MB file max in the layer).
				const { command, args } = JSON.parse(await readBody(req, 24 << 20));
				if (typeof command !== 'string') return sendJson(res, 400, { ok: false, error: 'command required' });
				return sendJson(res, 200, await call(command, Array.isArray(args) ? args : []));
			}
			if (pathname === '/__handide/bridge/status') return sendJson(res, 200, { ok: true, connected: extensionConnected() });
			if (pathname === '/__handide/fs' && req.method === 'GET') {
				const url = new URL(req.url, 'http://x');
				return sendJson(res, 200, await listDir(url.searchParams.get('path') || ''));
			}
		} catch (err) {
			return sendJson(res, 500, { ok: false, error: err.message });
		}
		sendJson(res, 404, { ok: false, error: 'not found' });
	}

	/** Private listener for the companion extension (127.0.0.1 only, secret header). */
	const internal = http.createServer(async (req, res) => {
		if (req.headers['x-handide-secret'] !== secret) return sendJson(res, 403, { error: 'forbidden' });
		lastPoll = Date.now();
		if (req.url === '/next' && req.method === 'GET') {
			polls.push(res);
			req.on('close', () => {
				const i = polls.indexOf(res);
				if (i >= 0) polls.splice(i, 1);
			});
			setTimeout(() => {
				const i = polls.indexOf(res);
				if (i >= 0) {
					polls.splice(i, 1);
					sendJson(res, 200, []);
				}
			}, 25_000);
			flush();
			return;
		}
		if (req.url === '/result' && req.method === 'POST') {
			try {
				const { id, ok, result, error } = JSON.parse(await readBody(req, 8 << 20));
				const entry = inflight.get(id);
				if (entry) {
					clearTimeout(entry.timer);
					inflight.delete(id);
					entry.resolve(ok ? { ok: true, result } : { ok: false, error });
				}
				return sendJson(res, 200, { ok: true });
			} catch (err) {
				return sendJson(res, 400, { error: err.message });
			}
		}
		sendJson(res, 404, { error: 'not found' });
	});

	async function listen() {
		await new Promise((ok) => internal.listen(0, '127.0.0.1', ok));
		const { port } = internal.address();
		log?.(`bridge on 127.0.0.1:${port}`);
		return { HANDIDE_BRIDGE_URL: `http://127.0.0.1:${port}`, HANDIDE_BRIDGE_SECRET: secret };
	}

	return { call, handleLayer, listen, extensionConnected, close: () => internal.close() };
}

/**
 * Directory listing for the drawer's folder picker. Same reach as VS Code itself
 * (the token already grants a terminal on this PC). Empty path = roots (drives on Windows).
 */
async function listDir(path) {
	if (!path) {
		if (process.platform === 'win32') {
			const drives = [];
			for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${l}:\\`)) drives.push({ name: `${l}:`, path: `${l}:\\`, dir: true });
			return { ok: true, path: '', parent: null, entries: drives };
		}
		path = '/';
	}
	const abs = resolve(path);
	const entries = [];
	for (const d of await readdir(abs, { withFileTypes: true })) {
		let dir = d.isDirectory();
		if (d.isSymbolicLink()) dir = await stat(join(abs, d.name)).then((s) => s.isDirectory(), () => false);
		entries.push({ name: d.name, path: join(abs, d.name), dir });
	}
	entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
	const root = parsePath(abs).root;
	return { ok: true, path: abs, parent: abs === root ? (process.platform === 'win32' ? '' : null) : dirname(abs), entries };
}
