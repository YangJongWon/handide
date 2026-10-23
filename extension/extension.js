// handide companion extension.
//
// Two ways in from the mobile layer (layer/mobile.js):
//  1. Command bridge (preferred): the layer asks the proxy to run a VS Code command
//     with arguments; this extension long-polls the proxy on a private 127.0.0.1 port
//     (HANDIDE_BRIDGE_URL / _SECRET, set when the proxy starts the editor server),
//     runs the command and posts the result back. File paths travel as {$file: path}.
//  2. Key chords (fallback): bound in package.json (generated from layer/commands.json)
//     to `handide.tab`.
//
// Views (`handide.view`), all built from official, idempotent commands. Maximizing the
// panel is a toggle whose state extensions cannot read, so the layer finishes that part
// by looking at the DOM:
//   editor        editor alone
//   terminalDock  editor on top, terminal docked below (the layer's bottom drawer)
//   terminal      terminal full screen (layer maximizes the panel; kept for key chords)
//   ai            the secondary side bar, maximized, on any extension's views (see below)
//   search / git  that view in the panel, full screen (layer maximizes)
// VS Code has no "maximize primary side bar", so Search and Source Control are moved
// into panel containers this extension contributes. Files are the layer's own drawer.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const run = (id, ...args) => vscode.commands.executeCommand(id, ...args);

/** view id → panel container (contributed in package.json) that makes it maximizable. */
const PANEL_HOMES = {
	'workbench.explorer.fileView': 'workbench.view.extension.handide-files',
	'workbench.view.search': 'workbench.view.extension.handide-search',
	'workbench.scm': 'workbench.view.extension.handide-git',
};

async function moveViewsToPanel() {
	for (const [viewId, destinationId] of Object.entries(PANEL_HOMES)) {
		try {
			// No-op when the view already lives there.
			await run('vscode.moveViews', { viewIds: [viewId], destinationId });
		} catch (err) {
			console.warn(`[handide] could not move ${viewId}: ${err.message}`);
		}
	}
}

const PANEL_VIEWS = {
	files: () => run('workbench.view.extension.handide-files'),
	search: () => run('workbench.view.extension.handide-search'),
	git: () => run('workbench.view.extension.handide-git'),
	terminal: () => run('workbench.action.terminal.focus'),
	terminalDock: () => run('workbench.action.terminal.focus'),
};

/** @param {{ view?: string, tab?: string }} args */
async function showView(args) {
	const view = args?.view ?? { code: 'editor', chat: 'ai' }[args?.tab] ?? args?.tab ?? 'editor';
	// The primary side bar is never used on a phone.
	await run('workbench.action.closeSidebar');
	if (PANEL_VIEWS[view]) {
		await run('workbench.action.closeAuxiliaryBar');
		await PANEL_VIEWS[view]();
		return;
	}
	if (view === 'ai') {
		// The secondary side bar, on the extension asked for or else the one shown last.
		await run('workbench.action.closePanel');
		const pick = args?.agent && extensionViews().find((a) => a.id === args.agent);
		if (pick?.extensionId) await memento?.update(LAST_AGENT_KEY, pick.extensionId);
		if (pick?.views) await borrowViews(pick);
		else await run(pick ? pick.id : 'workbench.action.focusAuxiliaryBar');
		await run('workbench.action.maximizeAuxiliaryBar');
		return;
	}
	await run('workbench.action.closePanel');
	await run('workbench.action.closeAuxiliaryBar');
	await run('workbench.action.maximizeEditorHideSidebar');
	await run('workbench.action.focusActiveEditorGroup');
}

// ---------------------------------------------------------------- extension views

// The phone hides the activity bar, the side bars' tabs and the primary side bar, so
// the layer lists every extension's views itself and shows the chosen one in the
// secondary side bar, which can be maximized. Containers already there (Claude Code,
// Codex…) just open. Views living elsewhere (primary side bar, panel, built-in
// containers like Explorer) are moved for the time being into this extension's
// container there, and moved back home when another one is chosen.
const BORROW_HOME = 'workbench.view.extension.handide-ext';
const BUILTIN_HOMES = {
	explorer: 'workbench.view.explorer',
	scm: 'workbench.view.scm',
	debug: 'workbench.view.debug',
	test: 'workbench.view.testing',
	remote: 'workbench.view.remote',
};
const BORROWED_KEY = 'handide.borrowed';
const LAST_AGENT_KEY = 'handide.lastAgent';
// Global: VS Code keeps view locations per profile, not per workspace.
let memento;
let selfId;
let selfPath;

/** "%key%" titles are looked up in the extension's package.nls.json. */
function localize(ext, text) {
	const key = /^%(.+)%$/.exec(text ?? '')?.[1];
	if (!key) return text;
	try {
		const nls = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'package.nls.json'), 'utf8'));
		const v = nls[key];
		return (typeof v === 'string' ? v : v?.message) || ext.packageJSON.displayName;
	} catch {
		return ext.packageJSON.displayName;
	}
}

/**
 * Every extension's views, as {id, title, extension} plus, for views that have to be
 * borrowed, {views: view ids, home: container to return them to}. VS Code's own chat last.
 */
function extensionViews() {
	const list = [];
	for (const ext of vscode.extensions.all) {
		const pj = ext.packageJSON ?? {};
		// The extensions the user installed; VS Code's built-in ones are its own UI.
		if (ext.id === selfId || pj.isBuiltin) continue;
		const containers = pj.contributes?.viewsContainers ?? {};
		const views = pj.contributes?.views ?? {};
		const extension = pj.displayName ? localize(ext, pj.displayName) : ext.id;
		// Containers an extension offers in both places (secondary when supported) appear once.
		const inSecondary = new Set();
		for (const c of containers.secondarySidebar ?? []) {
			const title = localize(ext, c.title) || c.id;
			inSecondary.add(title);
			list.push({ id: `workbench.view.extension.${c.id}`, title, extension, extensionId: ext.id });
		}
		const own = new Set();
		for (const c of [...(containers.activitybar ?? []), ...(containers.panel ?? [])]) {
			own.add(c.id);
			const title = localize(ext, c.title) || c.id;
			const ids = (views[c.id] ?? []).map((v) => v.id);
			if (inSecondary.has(title) || !ids.length) continue;
			list.push({ id: `workbench.view.extension.${c.id}`, title, extension, extensionId: ext.id, views: ids, home: `workbench.view.extension.${c.id}` });
		}
		for (const s of containers.secondarySidebar ?? []) own.add(s.id);
		// Views added to containers the extension does not own (Explorer, Source Control…).
		for (const [where, vs] of Object.entries(views)) {
			if (own.has(where)) continue;
			const home = BUILTIN_HOMES[where] ?? `workbench.view.extension.${where}`;
			for (const v of vs) {
				list.push({ id: `view:${v.id}`, title: localize(ext, v.name) || v.id, extension, extensionId: ext.id, views: [v.id], home });
			}
		}
	}
	list.push({ id: 'workbench.action.chat.open', title: 'Chat', extension: 'VS Code' });
	return list;
}

/**
 * Installed extensions, for managing them on the phone: VS Code's Extensions view is
 * stuck in the primary side bar (its views refuse to move), so the layer lists them and
 * opens one's details page (`extension.open`): disable, uninstall, settings.
 */
function installedExtensions() {
	// The server's registry, next to this extension: it also has the disabled ones, which
	// vscode.extensions leaves out (and which must stay reachable to enable them again).
	const extDir = path.dirname(selfPath);
	let registry = [];
	try {
		registry = JSON.parse(fs.readFileSync(path.join(extDir, 'extensions.json'), 'utf8'));
	} catch {}
	const list = [];
	for (const e of registry) {
		const id = e.identifier?.id;
		if (!id || id.toLowerCase() === selfId.toLowerCase()) continue;
		const extensionPath = e.location?.fsPath ?? path.join(extDir, e.relativeLocation ?? '');
		let packageJSON = {};
		try {
			packageJSON = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
		} catch {
			continue; // folder gone
		}
		const title = localize({ extensionPath, packageJSON }, packageJSON.displayName) || id;
		list.push({ id, title, enabled: !!vscode.extensions.getExtension(id) });
	}
	return list.sort((a, b) => a.title.localeCompare(b.title));
}

/** Opens extension management in a deterministic mobile-friendly editor layout. */
async function manageExtension({ id, action = 'details' }) {
	await showView({ view: 'editor' });
	if (action === 'install') {
		await run('workbench.action.quickOpen', 'ext install ');
		return { ok: true };
	}
	if (typeof id !== 'string' || !id.includes('.')) throw new Error('invalid extension id');
	if (action === 'settings') {
		await run('workbench.action.openSettings', `@ext:${id}`);
		return { ok: true };
	}
	// VS Code owns enable/disable/uninstall confirmation and reload requirements.
	await run('extension.open', id);
	return { ok: true };
}

async function returnBorrowed() {
	const borrowed = memento?.get(BORROWED_KEY);
	if (!borrowed) return;
	await run('vscode.moveViews', { viewIds: borrowed.views, destinationId: borrowed.home }).catch(() => {});
	await memento.update(BORROWED_KEY, undefined);
}

async function borrowViews(pick) {
	const borrowed = memento?.get(BORROWED_KEY);
	if (borrowed?.id !== pick.id) {
		await returnBorrowed();
		await memento?.update(BORROWED_KEY, { id: pick.id, views: pick.views, home: pick.home });
	}
	// Also opens the container; a no-op move when the views are already there.
	await run('vscode.moveViews', { viewIds: pick.views, destinationId: BORROW_HOME });
}

/** Activates the last-used agent on the PC while the phone stays in the editor. */
async function warmLastAgent() {
	const id = memento?.get(LAST_AGENT_KEY);
	if (!id) return;
	const extension = vscode.extensions.getExtension(id);
	if (extension) await extension.activate().catch(() => {});
}

/** New file (opened) or folder at an absolute path, for the layer's file drawer. */
async function create({ path: target, folder }) {
	const uri = vscode.Uri.file(target);
	const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
	if (exists) throw new Error(`already exists: ${target}`);
	if (folder) {
		await vscode.workspace.fs.createDirectory(uri);
		return { path: target };
	}
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)));
	await vscode.workspace.fs.writeFile(uri, new Uint8Array());
	await vscode.window.showTextDocument(uri);
	return { path: target };
}

/** Saves a phone-selected image where every workspace agent can read it. */
async function upload({ name, data }) {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) throw new Error('open a workspace folder first');
	if (typeof data !== 'string') throw new Error('image data required');
	const clean = path.basename(String(name || 'screenshot.png')).replace(/[^\p{L}\p{N}._-]+/gu, '-');
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const relative = `.handide/uploads/${stamp}-${clean || 'screenshot.png'}`;
	const uri = vscode.Uri.joinPath(root, ...relative.split('/'));
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.handide', 'uploads'));
	await vscode.workspace.fs.writeFile(uri, Uint8Array.from(Buffer.from(data, 'base64')));
	return { path: uri.fsPath, relative };
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', avif: 'image/avif' };
const imageType = (name) => IMAGE_TYPES[path.extname(name).slice(1).toLowerCase()];

/** One saved image by its file name; never a path, so nothing outside the folder is reached. */
function uploadUri(name) {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) throw new Error('open a workspace folder first');
	if (typeof name !== 'string' || !name || path.basename(name) !== name || !imageType(name)) throw new Error('not an uploaded image');
	return vscode.Uri.joinPath(root, '.handide', 'uploads', name);
}

/** The saved images, newest first, for the layer's gallery. */
async function uploads() {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) return [];
	const dir = vscode.Uri.joinPath(root, '.handide', 'uploads');
	const entries = await vscode.workspace.fs.readDirectory(dir).then((e) => e, () => []);
	const items = await Promise.all(
		entries
			.filter(([name, type]) => type === vscode.FileType.File && imageType(name))
			.map(async ([name]) => {
				const s = await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, name));
				return { name, relative: `.handide/uploads/${name}`, mtime: s.mtime, size: s.size };
			}),
	);
	return items.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}

async function readUpload({ name }) {
	const bytes = await vscode.workspace.fs.readFile(uploadUri(name));
	return { type: imageType(name), data: Buffer.from(bytes).toString('base64') };
}

async function deleteUpload({ name }) {
	await vscode.workspace.fs.delete(uploadUri(name), { useTrash: false });
	return true;
}

// ---------------------------------------------------------------- other PCs' projects

const PEER_SCHEME = 'handide-peer';
const DIRECTORY = 2; // entry type in proxy/projects.mjs (1: file)

/** handide-peer://<pc>/<path> → that PC's project, through this PC's handide (/peer/ on the bridge). */
async function peerFetch(pc, endpoint, query = {}, init = {}) {
	const url = process.env.HANDIDE_BRIDGE_URL;
	const secret = process.env.HANDIDE_BRIDGE_SECRET;
	if (!url || !secret) throw new Error('not started by handide');
	return fetch(`${url}/peer/${encodeURIComponent(pc)}/${endpoint}?${new URLSearchParams(query)}`, {
		...init,
		headers: { 'x-handide-secret': secret, ...init.headers },
	});
}

const peerPath = (uri) => uri.path.replace(/^\/+/, '');
const peerRoot = (pc) => vscode.Uri.from({ scheme: PEER_SCHEME, authority: pc, path: '/' });
const peerLabel = (p) => `${p.name}${p.project ? ` · ${p.project}` : ''}`;

// What is read is kept only while it is being used: files up to this many bytes in all
// (least recently used dropped first), anything not read again within IDLE_MS dropped.
const CACHE_BYTES = 32 << 20;
const CACHE_DIRS = 500;
const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const KNOWN_MAX = 2000;

/**
 * The other PCs' projects as read-only folders. Nothing is fetched until the editor asks:
 * a folder's entries when it is expanded, a file when it is opened. A PC's change stream
 * is open only while its files are being read: after IDLE_MS without a read it is closed
 * (so that PC stops watching its folder too) and what was cached of it is dropped; the
 * next read opens it again.
 */
class PeerFileSystem {
	constructor() {
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeFile = this._emitter.event;
		this.dirs = new Map(); // uri → { entries, at }, oldest first
		this.files = new Map(); // uri → { etag, data, at }, oldest first
		this.bytes = 0;
		this.streams = new Map(); // pc → { users, abort: AbortController | null, lastUsed, known: Set<uri> }
		setInterval(() => this._sweep(), SWEEP_MS).unref?.();
	}

	_stream(pc) {
		let s = this.streams.get(pc);
		if (!s) this.streams.set(pc, (s = { users: 0, abort: null, lastUsed: 0, known: new Set() }));
		return s;
	}

	/** A read: keeps the PC's change stream open (opening it if the editor watches the PC). */
	_touch(uri) {
		const s = this._stream(uri.authority);
		s.lastUsed = Date.now();
		if (s.users > 0 && !s.abort) {
			s.abort = new AbortController();
			this._listen(uri.authority, s, s.abort);
		}
	}

	/** Cache entries are trusted only while that PC's change stream is open. */
	_live(uri) {
		return !!this.streams.get(uri.authority)?.abort;
	}

	_forget(key) {
		const f = this.files.get(key);
		if (f) this.bytes -= f.data.byteLength;
		this.files.delete(key);
		this.dirs.delete(key);
	}

	_keepFile(key, entry) {
		this._forget(key);
		if (entry.data.byteLength > CACHE_BYTES / 4) return; // one big file must not evict everything
		this.files.set(key, entry);
		this.bytes += entry.data.byteLength;
		for (const [k] of this.files) {
			if (this.bytes <= CACHE_BYTES) break;
			this._forget(k);
		}
	}

	_keepDir(key, entries) {
		this.dirs.delete(key);
		this.dirs.set(key, { entries, at: Date.now() });
		for (const [k] of this.dirs) {
			if (this.dirs.size <= CACHE_DIRS) break;
			this.dirs.delete(k);
		}
	}

	_sweep() {
		const now = Date.now();
		for (const [key, f] of this.files) if (now - f.at > IDLE_MS) this._forget(key);
		for (const [key, d] of this.dirs) if (now - d.at > IDLE_MS) this.dirs.delete(key);
		for (const [pc, s] of this.streams) {
			if (!s.abort || now - s.lastUsed <= IDLE_MS) continue;
			s.abort.abort(); // idle: the other PC stops watching its folder for us
			s.abort = null;
			this._drop(pc);
		}
	}

	/** Everything cached of a PC; the paths read stay known, without their contents. */
	_drop(pc) {
		const prefix = `${PEER_SCHEME}://${pc}/`;
		for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this._forget(k);
		for (const k of [...this.dirs.keys()]) if (k.startsWith(prefix)) this.dirs.delete(k);
	}

	async _get(uri, endpoint, init) {
		let res;
		try {
			res = await peerFetch(uri.authority, endpoint, { path: peerPath(uri) }, init);
		} catch {
			throw vscode.FileSystemError.Unavailable(uri);
		}
		if (res.status === 404 || res.status === 400) throw vscode.FileSystemError.FileNotFound(uri);
		if (res.status === 502) throw vscode.FileSystemError.Unavailable(uri);
		return res;
	}

	async stat(uri) {
		const res = await this._get(uri, 'stat');
		if (!res.ok) throw vscode.FileSystemError.Unavailable(uri);
		const [type, size, mtime] = await res.json();
		return { type: type === DIRECTORY ? vscode.FileType.Directory : vscode.FileType.File, ctime: mtime, mtime, size, permissions: vscode.FilePermission.Readonly };
	}

	async readDirectory(uri) {
		const key = uri.toString();
		const live = this._live(uri);
		this._touch(uri);
		const cached = live && this.dirs.get(key);
		if (cached) {
			this._keepDir(key, cached.entries); // most recently used
			return cached.entries;
		}
		const res = await this._get(uri, 'list');
		if (!res.ok) throw vscode.FileSystemError.Unavailable(uri);
		const { entries } = await res.json();
		const mapped = entries.map(([name, type]) => [name, type === DIRECTORY ? vscode.FileType.Directory : vscode.FileType.File]);
		this._keepDir(key, mapped);
		return mapped;
	}

	async readFile(uri) {
		const key = uri.toString();
		this._touch(uri);
		const s = this._stream(uri.authority);
		if (s.known.size < KNOWN_MAX) s.known.add(key);
		const cached = this.files.get(key);
		// Even a cached file is checked: a 304 costs a round trip, not the file.
		const res = await this._get(uri, 'file', cached ? { headers: { 'if-none-match': cached.etag } } : {});
		if (res.status === 304 && cached) {
			this._keepFile(key, { ...cached, at: Date.now() });
			return cached.data;
		}
		if (!res.ok) throw vscode.FileSystemError.Unavailable(uri);
		const data = new Uint8Array(await res.arrayBuffer());
		const etag = res.headers.get('etag');
		if (etag) this._keepFile(key, { etag, data, at: Date.now() });
		return data;
	}

	/**
	 * The Other PCs view watches each PC for as long as it is listed; the change stream
	 * itself opens on the first read (_touch) and closes when idle (_sweep).
	 */
	watch(uri) {
		const s = this._stream(uri.authority);
		s.users += 1;
		if (Date.now() - s.lastUsed <= IDLE_MS) this._touch(uri);
		return new vscode.Disposable(() => {
			if (--s.users > 0 || !s.abort) return;
			s.abort.abort();
			s.abort = null;
			this._drop(uri.authority);
		});
	}

	async _listen(pc, stream, abort) {
		while (!abort.signal.aborted) {
			try {
				const res = await peerFetch(pc, 'events', {}, { signal: abort.signal });
				if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
				// (Re)connected: whatever was read while no stream was open may be stale, open
				// tabs included -- they are told to look again.
				this._changed(pc, ['*'], [...stream.known]);
				const decoder = new TextDecoder();
				let buffered = '';
				for await (const chunk of res.body) {
					buffered += decoder.decode(chunk, { stream: true });
					let end;
					while ((end = buffered.indexOf('\n\n')) >= 0) {
						const event = buffered.slice(0, end);
						buffered = buffered.slice(end + 2);
						const data = event.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
						if (data) this._changed(pc, JSON.parse(data));
					}
				}
			} catch {
				// the PC went off or the stream dropped; try again below
			}
			if (!abort.signal.aborted) {
				this._drop(pc); // not watched while disconnected: nothing cached can be trusted
				await new Promise((r) => setTimeout(r, 5000));
			}
		}
	}

	_changed(pc, paths, known = []) {
		const root = peerRoot(pc);
		if (paths.includes('*')) {
			this._drop(pc);
			return this._emitter.fire([root, ...known.map((k) => vscode.Uri.parse(k))].map((uri) => ({ type: vscode.FileChangeType.Changed, uri })));
		}
		const events = [];
		for (const p of paths) {
			const uri = vscode.Uri.joinPath(root, p);
			const parent = vscode.Uri.joinPath(uri, '..');
			this._forget(uri.toString());
			this.dirs.delete(parent.toString());
			events.push({ type: vscode.FileChangeType.Changed, uri }, { type: vscode.FileChangeType.Changed, uri: parent });
		}
		this._emitter.fire(events);
	}

	createDirectory(uri) {
		throw vscode.FileSystemError.NoPermissions(uri);
	}
	writeFile(uri) {
		throw vscode.FileSystemError.NoPermissions(uri);
	}
	delete(uri) {
		throw vscode.FileSystemError.NoPermissions(uri);
	}
	rename(uri) {
		throw vscode.FileSystemError.NoPermissions(uri);
	}
}

/**
 * The other PCs' projects as a tree in the Files panel (package.json: handide.peers),
 * read through PeerFileSystem. They are not workspace folders: extensions that take every
 * workspace folder for a local path (the Codex panel crashed on handide-peer://) never
 * see them.
 */
class PeersTree {
	constructor(files) {
		this.files = files;
		this.peers = [];
		this.watches = new Map(); // pc → Disposable
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._emitter.event;
		files.onDidChangeFile(() => this._emitter.fire());
	}

	/** The PCs from this PC's handide (/peer/ on the bridge), as `handide.setPeers` sends them. */
	async load() {
		const url = process.env.HANDIDE_BRIDGE_URL;
		const secret = process.env.HANDIDE_BRIDGE_SECRET;
		if (!url || !secret) return;
		const res = await fetch(`${url}/peer/`, { headers: { 'x-handide-secret': secret } }).catch(() => null);
		if (res?.ok) this.set(await res.json());
	}

	set(peers) {
		this.peers = peers;
		const names = new Set(peers.map((p) => p.name));
		for (const [pc, w] of this.watches) if (!names.has(pc)) (w.dispose(), this.watches.delete(pc));
		for (const pc of names) if (!this.watches.has(pc)) this.watches.set(pc, this.files.watch(peerRoot(pc)));
		run('setContext', 'handide.hasPeers', peers.length > 0);
		this._emitter.fire();
		return true;
	}

	/** Elements: { uri, dir, peer? } -- a PC (peer) or one of its folders and files. */
	async getChildren(el) {
		if (!el) return this.peers.map((peer) => ({ uri: peerRoot(peer.name), dir: true, peer }));
		const entries = await this.files.readDirectory(el.uri).catch(() => []);
		const dir = vscode.FileType.Directory;
		return entries
			.sort(([a, at], [b, bt]) => (at === bt ? a.localeCompare(b) : at === dir ? -1 : 1))
			.map(([name, type]) => ({ uri: vscode.Uri.joinPath(el.uri, name), dir: type === dir }));
	}

	getTreeItem({ uri, dir, peer }) {
		const item = new vscode.TreeItem(peer ? peerLabel(peer) : uri, dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		item.id = uri.toString();
		if (peer) item.iconPath = new vscode.ThemeIcon('remote');
		if (!dir) item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
		return item;
	}
}

let peersTree;

/**
 * Text search in the other PCs' projects, run on each PC (ripgrep over its folder) so
 * nothing is downloaded to search. The editor's own search does not reach these folders.
 */
async function searchPeers() {
	const pcs = peersTree?.peers ?? [];
	if (!pcs.length) return vscode.window.showInformationMessage('No other PC is reachable.');
	const q = await vscode.window.showInputBox({ prompt: 'Search the other PCs (text, case-insensitive)' });
	if (!q) return;
	const items = [];
	await Promise.all(
		pcs.map(async (p) => {
			const res = await peerFetch(p.name, 'search', { q }).catch(() => null);
			if (!res?.ok) return items.push({ label: `$(warning) ${peerLabel(p)}`, description: res ? `HTTP ${res.status}` : 'not reachable' });
			for (const [path, line, text] of (await res.json()).matches) {
				items.push({ label: `${path}:${line}`, description: peerLabel(p), detail: text, uri: vscode.Uri.joinPath(peerRoot(p.name), path), line });
			}
		}),
	);
	const pick = await vscode.window.showQuickPick(items, { matchOnDescription: true, matchOnDetail: true, placeHolder: `${items.length} result(s) for "${q}"` });
	if (!pick?.uri) return;
	const doc = await vscode.workspace.openTextDocument(pick.uri);
	const at = new vscode.Position(Math.max(0, pick.line - 1), 0);
	await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
}

function state() {
	const editor = vscode.window.activeTextEditor;
	return {
		folders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath, uri: f.uri.toString() })),
		active: editor ? { path: editor.document.uri.fsPath, uri: editor.document.uri.toString(), dirty: editor.document.isDirty } : null,
	};
}

// ---------------------------------------------------------------- bridge client

/** JSON args → VS Code values: {$file: path} and {$uri: string} become vscode.Uri. */
function revive(v) {
	if (Array.isArray(v)) return v.map(revive);
	if (v && typeof v === 'object') {
		if (typeof v.$file === 'string') return vscode.Uri.file(v.$file);
		if (typeof v.$uri === 'string') return vscode.Uri.parse(v.$uri);
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
	}
	return v;
}

function serialize(v) {
	if (v instanceof vscode.Uri) return { $uri: v.toString(), path: v.fsPath };
	try {
		return JSON.parse(JSON.stringify(v ?? null));
	} catch {
		return String(v);
	}
}

function startBridge(context) {
	const url = process.env.HANDIDE_BRIDGE_URL;
	const secret = process.env.HANDIDE_BRIDGE_SECRET;
	if (!url || !secret) return; // not started by the handide proxy
	let stopped = false;
	context.subscriptions.push({ dispose: () => (stopped = true) });
	const headers = { 'x-handide-secret': secret };
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	const handle = async ({ id, command, args }) => {
		let body;
		try {
			body = { id, ok: true, result: serialize(await run(command, ...revive(args ?? []))) };
		} catch (err) {
			body = { id, ok: false, error: String(err?.message ?? err) };
		}
		await fetch(`${url}/result`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
	};

	(async () => {
		while (!stopped) {
			try {
				const res = await fetch(`${url}/next`, { headers });
				if (!res.ok) throw new Error(`bridge ${res.status}`);
				for (const call of await res.json()) handle(call); // concurrently: a slow command must not block others
			} catch {
				await sleep(2000);
			}
		}
	})();
}

async function activate(context) {
	const peerFiles = new PeerFileSystem();
	peersTree = new PeersTree(peerFiles);
	context.subscriptions.push(
		vscode.commands.registerCommand('handide.view', showView),
		vscode.commands.registerCommand('handide.tab', showView),
		vscode.commands.registerCommand('handide.state', state),
		vscode.commands.registerCommand('handide.setPeers', ({ peers }) => peersTree.set(peers)),
		vscode.commands.registerCommand('handide.extensionViews', extensionViews),
		vscode.commands.registerCommand('handide.create', create),
		vscode.commands.registerCommand('handide.upload', upload),
		vscode.commands.registerCommand('handide.uploads', uploads),
		vscode.commands.registerCommand('handide.readUpload', readUpload),
		vscode.commands.registerCommand('handide.deleteUpload', deleteUpload),
		vscode.commands.registerCommand('handide.installedExtensions', installedExtensions),
		vscode.commands.registerCommand('handide.manageExtension', manageExtension),
		vscode.commands.registerCommand('handide.searchPeers', searchPeers),
		vscode.workspace.registerFileSystemProvider(PEER_SCHEME, peerFiles, { isCaseSensitive: true, isReadonly: true }),
		vscode.window.registerTreeDataProvider('handide.peers', peersTree),
	);
	peersTree.load();
	memento = context.globalState;
	selfId = context.extension.id;
	selfPath = context.extensionPath;
	startBridge(context);
	await moveViewsToPanel();
	setTimeout(warmLastAgent, 1200);
}

function deactivate() {}

module.exports = { activate, deactivate };
