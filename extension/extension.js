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
	context.subscriptions.push(
		vscode.commands.registerCommand('handide.view', showView),
		vscode.commands.registerCommand('handide.tab', showView),
		vscode.commands.registerCommand('handide.state', state),
		vscode.commands.registerCommand('handide.extensionViews', extensionViews),
		vscode.commands.registerCommand('handide.create', create),
		vscode.commands.registerCommand('handide.upload', upload),
		vscode.commands.registerCommand('handide.installedExtensions', installedExtensions),
		vscode.commands.registerCommand('handide.manageExtension', manageExtension),
	);
	memento = context.globalState;
	selfId = context.extension.id;
	selfPath = context.extensionPath;
	startBridge(context);
	await moveViewsToPanel();
	setTimeout(warmLastAgent, 1200);
}

function deactivate() {}

module.exports = { activate, deactivate };
