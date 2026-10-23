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
import { readdir, readFile, stat } from 'node:fs/promises';
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
			if (pathname === '/__handide/git' && req.method === 'GET') {
				const url = new URL(req.url, 'http://x');
				return sendJson(res, 200, await gitInfo(url.searchParams.get('path') || ''));
			}
		} catch (err) {
			return sendJson(res, 500, { ok: false, error: err.message });
		}
		sendJson(res, 404, { ok: false, error: 'not found' });
	}

	/** Private listener for the companion extension (127.0.0.1 only, secret header). */
	const routes = []; // [prefix, handler]: more for the extension (and terminals) than calls
	const internal = http.createServer(async (req, res) => {
		if (req.headers['x-handide-secret'] !== secret) return sendJson(res, 403, { error: 'forbidden' });
		const route = routes.find(([prefix]) => req.url.startsWith(prefix));
		if (route) return route[1](req, res);
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
				const { id, ok, result, error } = JSON.parse(await readBody(req, 24 << 20)); // a gallery image: up to 15MB, base64
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

	/** Serves `prefix` on the private listener (same secret) with `handler(req, res)`. */
	const route = (prefix, handler) => routes.push([prefix, handler]);

	return { call, handleLayer, listen, route, extensionConnected, close: () => internal.close() };
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

/**
 * Where a folder's project lives besides this PC (the drawer's long-press): the git
 * repository holding it, its branch and remotes, each with a web link when it is a host
 * like GitHub. Read from .git itself, so no git is needed. Credentials in a remote URL
 * are never sent back.
 */
async function gitInfo(path) {
	let dir = resolve(path);
	for (;;) {
		const git = join(dir, '.git');
		const s = await stat(git).catch(() => null);
		if (s) {
			// A worktree or submodule: .git is a file naming the real one, whose config may be shared (commondir).
			let gitDir = git;
			if (s.isFile()) gitDir = resolve(dir, (await readFile(git, 'utf8')).replace(/^gitdir:\s*/, '').trim());
			const common = await readFile(join(gitDir, 'commondir'), 'utf8').then((c) => resolve(gitDir, c.trim()), () => gitDir);
			const config = await readFile(join(common, 'config'), 'utf8').catch(() => '');
			const head = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => '');
			const remotes = [];
			for (const m of config.matchAll(/^\s*\[remote\s+"([^"]+)"\]([^[]*)/gm)) {
				const url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(m[2])?.[1];
				if (url) remotes.push({ name: m[1], url: withoutCredentials(url), web: webUrl(url) });
			}
			remotes.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
			return { ok: true, path: resolve(path), root: dir, branch: /^ref: refs\/heads\/(.+)/.exec(head.trim())?.[1] ?? null, remotes };
		}
		const up = dirname(dir);
		if (up === dir) return { ok: true, path: resolve(path), root: null, branch: null, remotes: [] };
		dir = up;
	}
}

const withoutCredentials = (url) => url.replace(/^(https?:\/\/)[^@/]+@/i, '$1');

/** https://host/owner/repo for git@host:owner/repo.git, ssh://, https:// (null for a local path). */
function webUrl(url) {
	const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url);
	if (!m || /^file:/i.test(url) || !m[1].includes('.')) return null;
	return `https://${m[1]}/${m[2]}`;
}
