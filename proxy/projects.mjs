// Each PC's project, readable on the others. handide shares the folder it serves (to
// its own access token only), and mirrors the projects of the other PCs it knows into
// <data dir>/peers/<pc>/<project>, read-only. Those mirrors are added to the editor's
// workspace, so search, quick open and the agents on this PC see the code of every PC,
// also while another PC is off (as it was when last seen).
//
//   PC A  ──GET /__handide/project/manifest──>  PC B   paths, sizes, mtimes
//         ──GET /__handide/project/file?path──>        changed files only
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { deviceRequest } from './devices.mjs';

const MANIFEST_PATH = '/__handide/project/manifest';
const FILE_PATH = '/__handide/project/file';
const MAX_FILE = 1 << 20; // larger files (builds, media) are not mirrored
const MAX_FILES = 20_000;
const LIST_TTL_MS = 5_000;
const SYNC_INTERVAL_MS = 15_000;
const SYNC_CONCURRENCY = 8;
// Walked folders without git: the usual generated and dependency folders are left out.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'target', '.next', '.cache', '.handide']);

const run = (cmd, args, cwd) =>
	new Promise((ok) => {
		const chunks = [];
		let child;
		try {
			child = spawn(cmd, args, { cwd, windowsHide: true });
		} catch {
			return ok(null);
		}
		child.stdout.on('data', (d) => chunks.push(d));
		child.on('error', () => ok(null));
		child.on('close', (code) => ok(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
	});

/** Project files, "/"-separated: git's view (tracked and untracked, minus ignored) when it is a repo. */
async function projectPaths(folder) {
	if (existsSync(join(folder, '.git'))) {
		const out = await run('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], folder);
		if (out !== null) return [...new Set(out.split('\0').filter(Boolean))].slice(0, MAX_FILES);
	}
	const found = [];
	const walk = async (dir, rel) => {
		for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (found.length >= MAX_FILES) return;
			const path = rel ? `${rel}/${d.name}` : d.name;
			if (d.isDirectory() && !SKIP_DIRS.has(d.name)) await walk(join(dir, d.name), path);
			else if (d.isFile()) found.push(path);
		}
	};
	await walk(folder, '');
	return found;
}

async function listProject(folder) {
	const files = [];
	for (const path of await projectPaths(folder)) {
		const s = await stat(join(folder, ...path.split('/'))).catch(() => null);
		if (s?.isFile() && s.size <= MAX_FILE) files.push([path, s.size, Math.round(s.mtimeMs)]);
	}
	return { project: basename(folder), files };
}

/** Serves this PC's project to the other PCs: the same access token as the editor. */
export function createProjectShare({ token, folder }) {
	let cached = null;
	const list = () => {
		if (!cached || Date.now() - cached.at > LIST_TTL_MS) cached = { at: Date.now(), value: listProject(folder) };
		return cached.value;
	};

	async function handle(req, res, pathname) {
		if (req.headers['x-handide-token'] !== token) return res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
		const manifest = await list();
		if (pathname === MANIFEST_PATH) {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			return res.end(JSON.stringify(manifest));
		}
		// Only paths of the listing: nothing outside the project, nothing it leaves out.
		const path = new URL(req.url, 'http://x').searchParams.get('path');
		if (!manifest.files.some((f) => f[0] === path)) return res.writeHead(404).end();
		const body = await readFile(join(folder, ...path.split('/'))).catch(() => null);
		if (!body) return res.writeHead(404).end();
		res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
		res.end(body);
	}

	return {
		/** Handles the request if it is one of the project paths. */
		handle(req, res) {
			const pathname = req.url.split('?')[0];
			if (pathname !== MANIFEST_PATH && pathname !== FILE_PATH) return false;
			handle(req, res, pathname).catch((err) => {
				if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(err.message);
			});
			return true;
		},
	};
}

// ---------------------------------------------------------------- mirrors

/** A manifest path as a path under `root`, or null when it would leave it. */
function localPath(root, path) {
	const parts = String(path).split('/');
	if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) return null;
	return join(root, ...parts);
}

/** Read-only files are kept read-only on purpose; Windows refuses to delete them otherwise. */
async function removeFile(file) {
	await chmod(file, 0o644).catch(() => {});
	await unlink(file).catch(() => {});
}

/**
 * Keeps <dataDir>/peers/<pc>/<project> in step with the other PCs' projects and
 * calls onChange(mirrors) when the set of mirrored projects changes.
 */
export function createProjectMirror({ dataDir, devices, log, onChange }) {
	const peersDir = join(dataDir, 'peers');
	const mirrors = new Map(); // pc name → { name, project, path }
	let timer;
	let running = false;

	const indexFile = (pc) => join(peersDir, pc, '.index.json');
	const readIndex = (pc) => readFile(indexFile(pc), 'utf8').then(JSON.parse, () => ({ project: null, files: {} }));

	/** Mirrors already on disk, e.g. of a PC that is off now. */
	async function loadKnown() {
		for (const d of devices.list()) {
			const index = await readIndex(d.name);
			if (index.project && existsSync(join(peersDir, d.name, index.project))) {
				mirrors.set(d.name, { name: d.name, project: index.project, path: join(peersDir, d.name, index.project) });
			}
		}
		return list();
	}

	async function syncDevice(device) {
		const auth = { 'x-handide-token': device.token };
		const r = await deviceRequest(device, MANIFEST_PATH, { headers: auth, timeoutMs: 10_000 });
		if (r.status !== 200) return; // offline handled by the caller; an older handide has no project to share
		const manifest = JSON.parse(r.body);
		if (!manifest.project || /[\\/:]/.test(manifest.project) || manifest.project.startsWith('.')) return;
		const pcDir = join(peersDir, device.name);
		const root = join(pcDir, manifest.project);
		const index = await readIndex(device.name);
		if (index.project !== manifest.project) {
			// The PC serves another project now: only its current one is kept.
			if (index.project) await rm(join(pcDir, index.project), { recursive: true, force: true }).catch(() => {});
			index.project = manifest.project;
			index.files = {};
		}
		await mkdir(root, { recursive: true });

		const wanted = new Map(manifest.files.map(([p, size, mtime]) => [p, `${size}:${mtime}`]));
		const stale = [...wanted].filter(([p, v]) => index.files[p] !== v);
		const gone = Object.keys(index.files).filter((p) => !wanted.has(p));
		for (const p of gone) {
			const file = localPath(root, p);
			if (file) await removeFile(file);
			delete index.files[p];
		}
		let next = 0;
		const worker = async () => {
			while (next < stale.length) {
				const [p, v] = stale[next++];
				const file = localPath(root, p);
				if (!file) continue;
				const got = await deviceRequest(device, `${FILE_PATH}?path=${encodeURIComponent(p)}`, { headers: auth, timeoutMs: 15_000 }).catch(() => null);
				if (got?.status !== 200) continue;
				await mkdir(dirname(file), { recursive: true });
				await removeFile(file);
				await writeFile(file, got.body);
				await chmod(file, 0o444).catch(() => {});
				index.files[p] = v;
			}
		};
		await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, worker));
		await writeFile(indexFile(device.name), JSON.stringify(index));
		if (stale.length || gone.length) log(`${device.name}: ${manifest.project} mirrored (${stale.length} updated, ${gone.length} removed)`);
		mirrors.set(device.name, { name: device.name, project: manifest.project, path: root });
	}

	const list = () => [...mirrors.values()].sort((a, b) => a.name.localeCompare(b.name));
	const signature = () => JSON.stringify(list());

	async function syncAll() {
		if (running) return;
		running = true;
		const before = signature();
		try {
			await devices.refresh();
			const names = new Set(devices.list().map((d) => d.name));
			for (const name of mirrors.keys()) if (!names.has(name)) mirrors.delete(name); // removed PCs
			for (const d of devices.list()) {
				await syncDevice(d).catch((err) => {
					if (!/did not answer|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/.test(err.message)) log(`${d.name}: mirror: ${err.message}`);
				});
			}
		} finally {
			running = false;
		}
		if (signature() !== before) onChange?.(list());
	}

	return {
		loadKnown,
		start() {
			syncAll();
			timer = setInterval(syncAll, SYNC_INTERVAL_MS);
			timer.unref?.();
		},
		stop: () => clearInterval(timer),
		list,
		peersDir,
	};
}

// ---------------------------------------------------------------- workspace

/** Workspace folders for the mirrors, as the editor shows them. */
export const mirrorFolders = (mirrors) => mirrors.map((m) => ({ name: `${m.name} · ${m.project} (read-only)`, path: m.path }));

/**
 * The workspace the editor opens: this PC's folder first, the other PCs' mirrors after
 * it. The editor reads it on each page load; an editor that is open already gets the
 * same folders from the companion extension (handide.setFolders), without a restart as
 * the first folder stays the same.
 */
export async function writeWorkspace({ dataDir, folder, mirrors }) {
	const dir = join(dataDir, 'workspaces', createHash('sha1').update(folder).digest('hex').slice(0, 12));
	const file = join(dir, `${basename(folder) || 'project'}.code-workspace`);
	const body = JSON.stringify(
		{
			folders: [{ path: folder }, ...mirrorFolders(mirrors)],
			// Mirrored files are read-only on disk: show them so instead of failing on save.
			settings: { 'files.readonlyFromPermissions': true },
		},
		null,
		'\t',
	) + '\n';
	await mkdir(dir, { recursive: true });
	if ((await readFile(file, 'utf8').catch(() => null)) !== body) await writeFile(file, body);
	return file;
}
