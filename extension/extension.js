// handide companion extension.
//
// The mobile layer (layer/mobile.js) can only send keystrokes. Each tab button sends
// a chord bound (in package.json, generated from layer/commands.json) to `handide.tab`
// with the tab name as args. This extension turns that into official VS Code
// commands, so the phone shows exactly one full-screen area at a time:
//
//   code      → editor maximized, everything else hidden
//   files/search/git/terminal → that view in the panel (the layer maximizes it)
//   chat      → secondary side bar maximized
//
// VS Code has no "maximize primary side bar", so on activation the Explorer, Search
// and Source Control views are moved into panel containers this extension contributes.
const vscode = require('vscode');

const run = (id, ...args) => vscode.commands.executeCommand(id, ...args);

/** view id → panel container (contributed in package.json) that makes it maximizable. */
const PANEL_HOMES = {
	'workbench.explorer.fileView': 'workbench.view.extension.handide-files',
	'workbench.view.search': 'workbench.view.extension.handide-search',
	'workbench.scm': 'workbench.view.extension.handide-git',
};

const PANEL_TABS = {
	files: () => run('workbench.view.extension.handide-files'),
	search: () => run('workbench.view.extension.handide-search'),
	git: () => run('workbench.view.extension.handide-git'),
	terminal: () => run('workbench.action.terminal.focus'),
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

/**
 * Opens the area for a tab using only idempotent commands. Maximizing the panel is a
 * toggle whose state extensions cannot read, so that part is left to the layer: it
 * sees the resulting DOM and sends `toggleMaximizedPanel` only when needed.
 * @param {{ tab: string }} args
 */
async function showTab(args) {
	const { tab } = args || {};
	// The primary side bar is never used on a phone: its views live in the panel.
	await run('workbench.action.closeSidebar');
	if (PANEL_TABS[tab]) {
		await run('workbench.action.closeAuxiliaryBar');
		await PANEL_TABS[tab]();
		return;
	}
	if (tab === 'chat') {
		await run('workbench.action.closePanel');
		await run('workbench.action.chat.open');
		await run('workbench.action.maximizeAuxiliaryBar');
		return;
	}
	// 'code' and anything unknown: back to the editor.
	await run('workbench.action.closePanel');
	await run('workbench.action.closeAuxiliaryBar');
	await run('workbench.action.maximizeEditorHideSidebar');
	await run('workbench.action.focusActiveEditorGroup');
}

async function activate(context) {
	context.subscriptions.push(vscode.commands.registerCommand('handide.tab', showTab));
	await moveViewsToPanel();
}

function deactivate() {}

module.exports = { activate, deactivate };
