// Each PC's project, readable from the others, fetched only when it is looked at.
// handide shares the folder it serves (to its own access token only); the editor on
// another PC shows it as a read-only handide-peer://<pc>/ folder (extension/extension.js)
// whose folders and files are asked for as they are opened. Nothing is copied ahead of
// time, so there is no file limit and nothing to poll: the owning PC watches its folder
// and pushes the paths that changed.
//
//   PC A  ──GET /__handide/project/list?path──>    PC B   one folder's entries
//         ──GET /__handide/project/file?path──>           one file (ETag, 304)
//         ──GET /__handide/project/events──>              changed paths (SSE, fs.watch)
//         ──GET /__handide/project/search?q──>            matches, searched on PC B
//
// On PC A the editor and the `handide peer` command reach PC B through the bridge's
// private listener: /peer/<pc>/<endpoint> (createPeerRelay below).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, watch } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import os from 'node:os';
import { deviceRequest, openDeviceRequest } from './devices.mjs';

const PREFIX = '/__handide/project/';
const ENDPOINTS = new Set(['info', 'list', 'stat', 'file', 'events', 'search']);
// Shown nowhere: git's own store is noise in a file tree and huge.
const HIDDEN = new Set(['.git']);
const MAX_FILE = 64 << 20;
const MAX_MATCHES = 500;
const EVENT_BATCH_MS = 300;
const EVENT_MAX_PATHS = 1000; // more at once (a checkout, an install): "everything changed"
const HEARTBEAT_MS = 20_000;
export const PEER_SCHEME = 'handide-peer';
const FILE = 1;
const DIRECTORY = 2;

/** "a/b.txt" → an absolute path inside `folder`, or null when it would leave it. */
function inside(folder, path) {
	const parts = String(path ?? '').split('/').filter(Boolean);
	if (parts.some((p) => p === '.' || p === '..' || /[\\:\0]/.test(p))) return null;
	return join(folder, ...parts);
}

async function entryOf(abs) {
	const s = await stat(abs);
	return [s.isDirectory() ? DIRECTORY : FILE, s.size, Math.round(s.mtimeMs)];
}

/** ripgrep: on PATH, or the one every VS Code (and its serve-web) ships. */
function findRipgrep() {
	const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const candidates = [];
	const serveWeb = join(os.homedir(), '.vscode', 'cli', 'serve-web');
	const plat = `${process.platform}-${process.arch}`;
	try {
		for (const commit of readdirSync(serveWeb)) {
			candidates.push(join(serveWeb, commit, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', plat, exe));
			candidates.push(join(serveWeb, commit, 'node_modules', '@vscode', 'ripgrep', 'bin', exe));
		}
	} catch {
		// no serve-web yet
	}
	const app = process.platform === 'darwin'
		? '/Applications/Visual Studio Code.app/Contents/Resources/app'
		: join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'resources', 'app');
	candidates.push(join(app, 'node_modules', '@vscode', 'ripgrep', 'bin', exe));
	const found = candidates
		.map((p) => ({ p, t: statSync(p, { throwIfNoEntry: false })?.mtimeMs }))
		.filter((c) => c.t)
		.sort((a, b) => b.t - a.t);
	return found[0]?.p ?? 'rg';
}

/** Up to `max` matches of the literal `q` (case-insensitive), as [path, line, text]. */
function search(folder, q, max) {
	return new Promise((ok) => {
		const matches = [];
		let buffered = '';
		let child;
		try {
			child = spawn(findRipgrep(), ['--json', '-F', '-i', '--max-filesize', '1M', '--max-count', '50', '--', q, '.'], { cwd: folder, windowsHide: true });
		} catch {
			return ok(null);
		}
		child.stdout.on('data', (d) => {
			buffered += d;
			let nl;
			while ((nl = buffered.indexOf('\n')) >= 0) {
				const line = buffered.slice(0, nl);
				buffered = buffered.slice(nl + 1);
				try {
					const m = JSON.parse(line);
					if (m.type !== 'match') continue;
					const path = (m.data.path.text ?? '').replace(/^\.[\\/]/, '').split(sep).join('/');
					matches.push([path, m.data.line_number, (m.data.lines.text ?? '').trim().slice(0, 240)]);
				} catch {
					// a partial or non-JSON line
				}
				if (matches.length >= max) {
					child.kill();
					break;
				}
			}
		});
		child.on('error', () => ok(null));
		child.on('close', () => ok(matches));
	});
}

/** Paths that changed under `folder`, batched, for as long as anyone listens. */
function createWatcher(folder) {
	const listeners = new Set();
	let watcher = null;
	let pending = new Set();
	let timer = null;

	const send = (paths) => {
		for (const fn of listeners) fn(paths);
	};
	const flush = () => {
		timer = null;
		const paths = pending.size > EVENT_MAX_PATHS ? ['*'] : [...pending];
		pending = new Set();
		if (paths.length) send(paths);
	};
	const start = () => {
		try {
			watcher = watch(folder, { recursive: true }, (_event, name) => {
				if (!name) return pending.add('*');
				const path = String(name).split(sep).join('/');
				if (path === '.git' || path.startsWith('.git/')) return;
				pending.add(path);
				timer ??= setTimeout(flush, EVENT_BATCH_MS);
			});
			watcher.on('error', () => {
				watcher?.close();
				watcher = null;
				send(['*']); // lost track: the editor rereads what it shows
			});
		} catch {
			watcher = null;
		}
	};

	return {
		subscribe(fn) {
			listeners.add(fn);
			if (!watcher) start();
			return () => {
				listeners.delete(fn);
				if (!listeners.size && watcher) {
					watcher.close();
					watcher = null;
				}
			};
		},
	};
}

/** Serves this PC's project to the other PCs: the same access token as the editor. */
export function createProjectShare({ token, folder }) {
	const watcher = createWatcher(folder);

	async function handle(req, res, endpoint, url) {
		const path = url.searchParams.get('path') ?? '';
		const json = (status, body) => {
			res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify(body));
		};
		if (endpoint === 'info') return json(200, { project: basename(folder) });
		if (endpoint === 'search') {
			const q = url.searchParams.get('q') ?? '';
			if (!q) return json(400, { error: 'q required' });
			const max = Math.min(Number(url.searchParams.get('max')) || MAX_MATCHES, MAX_MATCHES);
			const matches = await search(folder, q, max);
			return matches ? json(200, { matches }) : json(501, { error: 'ripgrep not found on this PC' });
		}
		if (endpoint === 'events') {
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
			res.write(': connected\n\n');
			const unsubscribe = watcher.subscribe((paths) => res.write(`data: ${JSON.stringify(paths)}\n\n`));
			const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
			req.on('close', () => {
				clearInterval(beat);
				unsubscribe();
			});
			return;
		}
		const abs = inside(folder, path);
		if (!abs) return json(400, { error: 'bad path' });
		if (endpoint === 'stat') {
			const entry = await entryOf(abs).catch(() => null);
			return entry ? json(200, entry) : json(404, { error: 'not found' });
		}
		if (endpoint === 'list') {
			const dirents = await readdir(abs, { withFileTypes: true }).catch(() => null);
			if (!dirents) return json(404, { error: 'not found' });
			const entries = [];
			for (const d of dirents) {
				if (HIDDEN.has(d.name)) continue;
				const entry = await entryOf(join(abs, d.name)).catch(() => null); // broken links are left out
				if (entry) entries.push([d.name, ...entry]);
			}
			return json(200, { entries });
		}
		// file
		const s = await stat(abs).catch(() => null);
		if (!s) return json(404, { error: 'not found' });
		if (s.isDirectory()) return json(400, { error: 'is a folder' });
		if (s.size > MAX_FILE) return json(413, { error: 'too large' });
		const etag = `"${s.size}-${Math.round(s.mtimeMs)}"`;
		if (req.headers['if-none-match'] === etag) return res.writeHead(304, { etag }).end();
		res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': s.size, etag, 'cache-control': 'no-store' });
		createReadStream(abs).on('error', () => res.destroy()).pipe(res);
	}

	return {
		/** Handles the request if it is one of the project paths. */
		handle(req, res) {
			const url = new URL(req.url, 'http://x');
			if (!url.pathname.startsWith(PREFIX)) return false;
			const endpoint = url.pathname.slice(PREFIX.length);
			if (!ENDPOINTS.has(endpoint)) return false;
			if (req.headers['x-handide-token'] !== token) {
				res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
				return true;
			}
			handle(req, res, endpoint, url).catch((err) => {
				if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(err.message);
			});
			return true;
		},
	};
}

// ---------------------------------------------------------------- relay

/**
 * /peer/<pc>/<endpoint>?… on the bridge's private listener → that PC's project endpoint,
 * streamed through (files byte for byte, the change stream as it comes). /peer/ lists the
 * PCs and their projects.
 */
export function createPeerRelay({ devices }) {
	const projects = new Map(); // pc → project name, once seen

	async function projectOf(device) {
		const r = await deviceRequest(device, `${PREFIX}info`, { headers: { 'x-handide-token': device.token }, timeoutMs: 2500 }).catch(() => null);
		if (r?.status === 200) {
			const { project } = JSON.parse(r.body.toString('utf8'));
			if (typeof project === 'string') projects.set(device.name, project);
		}
		return projects.get(device.name) ?? null;
	}

	/** The other PCs with the project each serves (the last one seen while a PC is off). */
	async function list() {
		return Promise.all(devices.list().map(async (d) => ({ name: d.name, project: await projectOf(d) })));
	}

	async function handle(req, res) {
		const url = new URL(req.url, 'http://x');
		const [, , pc, endpoint] = url.pathname.split('/').map(decodeURIComponent);
		if (!pc) {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			return res.end(JSON.stringify(await list()));
		}
		const device = devices.list().find((d) => d.name === pc);
		if (!device || !ENDPOINTS.has(endpoint)) return res.writeHead(404).end();
		const headers = { 'x-handide-token': device.token };
		if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match'];
		let up;
		try {
			up = await openDeviceRequest(device, `${PREFIX}${endpoint}${url.search}`, { headers });
		} catch (err) {
			res.writeHead(502, { 'content-type': 'text/plain' });
			return res.end(`${pc} is not reachable: ${err.message}`);
		}
		const pass = {};
		for (const h of ['content-type', 'content-length', 'etag', 'cache-control']) if (up.headers[h]) pass[h] = up.headers[h];
		res.writeHead(up.statusCode, pass);
		up.pipe(res);
		req.on('close', () => up.destroy());
	}

	return {
		list,
		handle: (req, res) =>
			handle(req, res).catch((err) => {
				if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(err.message);
			}),
	};
}

// ---------------------------------------------------------------- workspace

/** Workspace folders for the other PCs, as the editor shows them. */
export const peerFolders = (peers) =>
	peers.map((p) => ({ uri: `${PEER_SCHEME}://${p.name}/`, name: `${p.name}${p.project ? ` · ${p.project}` : ''} (read-only)` }));

/**
 * The workspace the editor opens: this PC's folder first, the other PCs' projects after
 * it. The editor reads it on each page load; an editor that is open already gets the
 * same folders from the companion extension (handide.setFolders), without a restart as
 * the first folder stays the same.
 */
export async function writeWorkspace({ dataDir, folder, peers }) {
	const dir = join(dataDir, 'workspaces', createHash('sha1').update(folder).digest('hex').slice(0, 12));
	const file = join(dir, `${basename(folder) || 'project'}.code-workspace`);
	const body = JSON.stringify({ folders: [{ path: folder }, ...peerFolders(peers)] }, null, '\t') + '\n';
	await mkdir(dir, { recursive: true });
	if ((await readFile(file, 'utf8').catch(() => null)) !== body) await writeFile(file, body);
	return file;
}
