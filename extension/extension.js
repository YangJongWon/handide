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
//   terminalDock  editor on top, terminal docked below
//   terminal      terminal full screen (layer maximizes the panel)
//   ai            chat in the secondary side bar, maximized
//   search / git  that view in the panel, full screen (layer maximizes)
// VS Code has no "maximize primary side bar", so Search and Source Control are moved
// into panel containers this extension contributes. Files are the layer's own drawer.
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
		await run('workbench.action.closePanel');
		await run('workbench.action.chat.open');
		await run('workbench.action.maximizeAuxiliaryBar');
		return;
	}
	await run('workbench.action.closePanel');
	await run('workbench.action.closeAuxiliaryBar');
	await run('workbench.action.maximizeEditorHideSidebar');
	await run('workbench.action.focusActiveEditorGroup');
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
	);
	startBridge(context);
	await moveViewsToPanel();
}

function deactivate() {}

module.exports = { activate, deactivate };
