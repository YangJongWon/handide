// handide in the desktop editor (VS Code or Cursor): open a project of another PC of this
// account where it lives, through Remote - SSH, so it runs with that PC's git, terminals,
// language servers and agents; and switch a project between running there and running
// here, in a working copy kept in step with git (proxy/switch.mjs), in the same window,
// with the open files reopened. The status bar always says where this window runs.
//
// The PCs, their folders and the switches come from the handide command ("handide devices
// --json", "handide switch ..."); "handide desktop" installs this extension and records in
// handide.json how to run that command, since an editor started from the Dock or the
// Start menu may not have it on its PATH.
const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REMOTE_SSH = { cursor: 'anysphere.remote-ssh', vscode: 'ms-vscode-remote.remote-ssh' };
const PLATFORM = { win32: 'windows', darwin: 'macOS', linux: 'linux' };

function handideCommand() {
	try {
		const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'handide.json'), 'utf8'));
		return { cmd: c.node, pre: [c.server] };
	} catch {
		return { cmd: 'handide', pre: [] };
	}
}

/** Runs the handide command; resolves to the JSON of its last output line. */
function handide(args, timeout = 30_000) {
	const { cmd, pre } = handideCommand();
	return new Promise((ok, fail) => {
		execFile(cmd, [...pre, ...args], { timeout, windowsHide: true, maxBuffer: 16 << 20, shell: cmd === 'handide' && process.platform === 'win32' }, (err, out, errOut) => {
			let result;
			try {
				result = JSON.parse(String(out).trim().split(/\r?\n/).pop());
			} catch {
				return fail(new Error(String(errOut || err?.message || 'handide answered something unexpected; update it ("handide desktop" again)').trim()));
			}
			if (result && result.ok === false) return fail(new Error(result.error));
			ok(result);
		});
	});
}

/** The other PCs: [{ name, online, host, platform, sshServer, folder, recent }]. */
const listPCs = () => handide(['devices', '--json']);

/** "c:\Users\x" → "/c:/Users/x": the path of a remote folder URI. */
const remotePath = (p) => (/^[a-zA-Z]:[\\/]/.test(p) ? `/${p.replace(/\\/g, '/')}` : p);
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** The PC this window runs on, when it is one handide opened ("ssh-remote+handide-<pc>"). */
function currentPC() {
	const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
	const m = uri?.scheme === 'vscode-remote' && /^ssh-remote\+handide-(.+)$/.exec(uri.authority);
	return m ? m[1] : null;
}

async function ensureRemoteSSH() {
	const id = /cursor/i.test(vscode.env.appName) ? REMOTE_SSH.cursor : REMOTE_SSH.vscode;
	if (vscode.extensions.getExtension(REMOTE_SSH.cursor) || vscode.extensions.getExtension(REMOTE_SSH.vscode)) return true;
	const install = 'Install';
	const pick = await vscode.window.showInformationMessage(`Opening a project on another PC needs the Remote - SSH extension (${id}).`, install);
	if (pick !== install) return false;
	await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
	return true;
}

async function openOnPC() {
	let pcs;
	try {
		pcs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'handide: looking for your PCs…' }, listPCs);
	} catch (err) {
		return vscode.window.showErrorMessage(`handide: ${err.message}`);
	}
	if (!pcs.length) {
		return vscode.window.showInformationMessage('handide: no other PCs yet. Run "handide" on them, signed in to Tailscale with the same account.');
	}
	const here = currentPC();
	const pc = await vscode.window.showQuickPick(
		pcs.map((p) => ({
			label: `$(vm) ${p.name}`,
			description: [p.online ? PLATFORM[p.platform] ?? '' : 'offline', p.name === here ? 'this window' : ''].filter(Boolean).join(' · '),
			detail: p.folder ? `handide: ${p.folder}` : undefined,
			pc: p,
		})),
		{ title: 'Open a project on another PC', placeHolder: 'Pick a PC' },
	);
	if (!pc) return;
	const p = pc.pc;
	if (!p.online) return vscode.window.showWarningMessage(`handide: ${p.name} is not answering. Start handide on it, then try again.`);
	if (!p.host) return vscode.window.showWarningMessage(`handide: ${p.name} runs an older handide. Update it there, then start it again.`);
	if (!p.sshServer) {
		const copy = 'Copy command';
		const r = await vscode.window.showWarningMessage(`handide: SSH is not on yet on ${p.name}. Run this there once (it asks for administrator rights): handide ssh`, copy);
		if (r === copy) await vscode.env.clipboard.writeText('handide ssh');
		return;
	}

	const folders = [...new Set([p.folder, ...(p.recent ?? [])].filter(Boolean))];
	const OTHER = '$(folder-opened) Another folder…';
	const picked = await vscode.window.showQuickPick(
		[
			...folders.map((f, i) => ({ label: `$(folder) ${baseName(f)}`, description: f, detail: i === 0 && f === p.folder ? 'open in handide on that PC now' : undefined, folder: f })),
			{ label: OTHER, folder: null },
		],
		{ title: `Open on ${p.name}`, placeHolder: 'Pick a folder', matchOnDescription: true },
	);
	if (!picked) return;
	let folder = picked.folder;
	if (!folder) {
		folder = await vscode.window.showInputBox({ title: `Folder on ${p.name}`, value: p.folder ?? '', prompt: 'Full path of the folder on that PC' });
		if (!folder) return;
	}
	if (!(await ensureRemoteSSH())) return;

	await setRemotePlatform(p.host, p.platform);
	const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${p.host}`, path: remotePath(folder) });
	await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

// ---------------------------------------------------------------- switching where it runs

const PENDING = 'handide.pendingRestore'; // globalState: what to reopen in the window a switch opens
const folderUri = () => vscode.workspace.workspaceFolders?.[0]?.uri;

/** The working copy this window has open, if it is one handide made: { pc, remote, local }. */
async function currentCopy() {
	const uri = folderUri();
	if (!uri || uri.scheme !== 'file') return null;
	const { copies } = await handide(['switch', 'list']).catch(() => ({ copies: [] }));
	const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return copies.find((c) => norm(c.local) === norm(uri.fsPath)) ?? null;
}

/** Open editors as paths relative to the folder, to reopen on the other side of a switch. */
function openFiles() {
	const root = folderUri();
	const rel = (uri) => (root && uri.toString().startsWith(`${root.toString()}/`) ? decodeURIComponent(uri.toString().slice(root.toString().length + 1)) : null);
	const files = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const r = tab.input instanceof vscode.TabInputText ? rel(tab.input.uri) : null;
			if (r && !files.includes(r)) files.push(r);
		}
	}
	const editor = vscode.window.activeTextEditor;
	const active = editor ? rel(editor.document.uri) : null;
	const sel = editor?.selection;
	return { files, active, selection: sel ? [sel.start.line, sel.start.character, sel.end.line, sel.end.character] : null };
}

async function restorePending(context) {
	const uri = folderUri();
	const all = context.globalState.get(PENDING) ?? {};
	const pending = uri && all[uri.toString()];
	if (!pending) return;
	delete all[uri.toString()];
	await context.globalState.update(PENDING, all);
	if (Date.now() - pending.at > 10 * 60_000) return;
	for (const f of pending.files) {
		if (f === pending.active) continue;
		await vscode.window.showTextDocument(vscode.Uri.joinPath(uri, ...f.split('/')), { preview: false, preserveFocus: true }).then(undefined, () => {});
	}
	if (pending.active) {
		const editor = await vscode.window.showTextDocument(vscode.Uri.joinPath(uri, ...pending.active.split('/')), { preview: false }).then(undefined, () => null);
		if (editor && pending.selection) {
			const [a, b, c, d] = pending.selection;
			editor.selection = new vscode.Selection(a, b, c, d);
			editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
		}
	}
	if (pending.notes?.length) vscode.window.showInformationMessage(`handide: ${pending.notes.join(' ')}`);
}

function notesOf(r, where) {
	const notes = [];
	if (r.stashed) notes.push(`Edits made on ${where} while the project ran elsewhere were kept in a git stash there ("git stash list").`);
	if (r.backup) notes.push(`Commits made on ${where} meanwhile are on the branch ${r.backup}.`);
	return notes;
}

/** Saves, moves the work over, then opens the other side in this window with the same files. */
async function switchTo(context, run, target, label) {
	await vscode.workspace.saveAll(false);
	const open = openFiles();
	let result;
	try {
		result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `handide: moving this project to ${label}…` }, () => run());
	} catch (err) {
		return vscode.window.showErrorMessage(`handide: could not switch: ${err.message}`);
	}
	const { uri, where, prepare } = target(result);
	if (prepare) await prepare();
	const all = context.globalState.get(PENDING) ?? {};
	all[uri.toString()] = { ...open, at: Date.now(), notes: notesOf(result, where) };
	await context.globalState.update(PENDING, all);
	await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
}

/** Remote - SSH asks for the PC's OS on the first connection unless told. */
async function setRemotePlatform(host, platform) {
	const config = vscode.workspace.getConfiguration('remote.SSH');
	const platforms = { ...(config.get('remotePlatform') ?? {}) };
	if (PLATFORM[platform] && platforms[host] !== PLATFORM[platform]) {
		platforms[host] = PLATFORM[platform];
		await config.update('remotePlatform', platforms, vscode.ConfigurationTarget.Global);
	}
}

const HERE = { darwin: 'this Mac', win32: 'this PC', linux: 'this PC' }[process.platform] ?? 'this PC';

async function switchMenu(context) {
	const pc = currentPC();
	const copy = pc ? null : await currentCopy();
	const items = [];
	if (pc) {
		const remote = folderUri().path.replace(/^\/([a-zA-Z]:)/, '$1');
		items.push({ label: `$(vm) Run on ${pc}`, description: 'running here now', run: null });
		items.push({
			label: `$(device-desktop) Run on ${HERE}`,
			description: 'in a working copy, kept in step with git',
			detail: 'Uncommitted and new files come along; the branch and commits stay as they are.',
			run: () =>
				switchTo(context, () => handide(['switch', 'here', pc, remote], 10 * 60_000), (r) => ({ uri: vscode.Uri.file(r.local), where: pc }), HERE),
		});
	} else if (copy) {
		items.push({ label: `$(device-desktop) Run on ${HERE}`, description: `running here now · copy of ${copy.pc}`, run: null });
		items.push({
			label: `$(vm) Run on ${copy.pc}`,
			description: copy.remote,
			detail: 'Your work here (uncommitted and new files too) goes back to that PC first.',
			run: () =>
				switchTo(
					context,
					() => handide(['switch', 'back', folderUri().fsPath], 10 * 60_000),
					(r) => ({
						uri: vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${r.host}`, path: remotePath(r.remote) }),
						where: HERE,
						prepare: async () => {
							await ensureRemoteSSH();
							await setRemotePlatform(r.host, r.platform);
						},
					}),
					copy.pc,
				),
		});
	}
	items.push({ label: '$(folder-opened) Open a project on another PC…', run: openOnPC });
	const picked = await vscode.window.showQuickPick(items, { title: 'Where should this project run?' });
	if (picked?.run) await picked.run();
}

function activate(context) {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	item.command = 'handide.switch';
	const pc = currentPC();
	if (pc) {
		item.text = `$(vm) ${pc} $(arrow-swap)`;
		item.tooltip = `This project runs on ${pc}. Switch where it runs…`;
	} else {
		item.text = '$(vm) PCs';
		item.tooltip = 'handide: open a project on another PC…';
		currentCopy().then((copy) => {
			if (!copy) return;
			item.text = `$(device-desktop) ${HERE} · ${copy.pc} $(arrow-swap)`;
			item.tooltip = `This project runs on ${HERE}, in a working copy of ${copy.pc}:${copy.remote}. Switch where it runs…`;
		});
	}
	item.show();
	context.subscriptions.push(
		item,
		vscode.commands.registerCommand('handide.openOnPC', openOnPC),
		vscode.commands.registerCommand('handide.switch', () => switchMenu(context)),
	);
	restorePending(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
