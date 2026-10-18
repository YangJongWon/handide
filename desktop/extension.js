// handide in the desktop editor (VS Code or Cursor): open a project of another PC of this
// account where it lives, through Remote - SSH, so it runs with that PC's git, terminals,
// language servers and agents. The PCs and their folders come from the handide command
// ("handide devices --json"); "handide desktop" installs this extension and records in
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

/** The other PCs: [{ name, online, host, platform, sshServer, folder, recent }]. */
function listPCs() {
	const { cmd, pre } = handideCommand();
	return new Promise((ok, fail) => {
		execFile(cmd, [...pre, 'devices', '--json'], { timeout: 30_000, windowsHide: true, shell: cmd === 'handide' && process.platform === 'win32' }, (err, out, errOut) => {
			if (err) return fail(new Error(String(errOut || err.message).trim()));
			try {
				ok(JSON.parse(String(out).trim().split(/\r?\n/).pop()));
			} catch {
				fail(new Error('handide answered something unexpected; update it ("handide desktop" again)'));
			}
		});
	});
}

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

	// Remote - SSH asks for the PC's OS on the first connection unless told.
	const config = vscode.workspace.getConfiguration('remote.SSH');
	const platforms = { ...(config.get('remotePlatform') ?? {}) };
	if (PLATFORM[p.platform] && platforms[p.host] !== PLATFORM[p.platform]) {
		platforms[p.host] = PLATFORM[p.platform];
		await config.update('remotePlatform', platforms, vscode.ConfigurationTarget.Global);
	}
	const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${p.host}`, path: remotePath(folder) });
	await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

function activate(context) {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	const pc = currentPC();
	item.text = pc ? `$(vm) ${pc}` : '$(vm) PCs';
	item.tooltip = pc ? `This window runs on ${pc} (handide). Open a project on another PC…` : 'handide: open a project on another PC…';
	item.command = 'handide.openOnPC';
	item.show();
	context.subscriptions.push(item, vscode.commands.registerCommand('handide.openOnPC', openOnPC));
}

function deactivate() {}

module.exports = { activate, deactivate };
