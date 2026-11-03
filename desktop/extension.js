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
//
// Open on Phone (the phone button in the status bar): a QR code that opens this window's
// project in handide on the phone, starting handide first when it is not running: the
// installed one, else the one inside this extension (runtime.js).
const vscode = require('vscode');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { bundledHandide, bundledReady } = require('./runtime');

const REMOTE_SSH = { cursor: 'anysphere.remote-ssh', vscode: 'ms-vscode-remote.remote-ssh' };
const PLATFORM = { win32: 'windows', darwin: 'macOS', linux: 'linux' };

/** The first file of `names` in one of `dirs`. */
const findIn = (dirs, names) => {
	for (const d of dirs) for (const n of names) if (d && fs.existsSync(path.join(d, n))) return path.join(d, n);
	return null;
};

/**
 * Node and handide's server.mjs: from handide.json ("handide desktop"), else from where
 * handide is installed (the Windows installer, or npm's "handide" shim on the PATH). Run
 * as node + script, never through a shell: on Windows a shell started detached opens a
 * console window for node.
 */
function locateHandide() {
	try {
		const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'handide.json'), 'utf8'));
		if (fs.existsSync(c.node) && fs.existsSync(c.server)) return c;
	} catch {
		// not installed by "handide desktop": look below
	}
	const pathDirs = (process.env.PATH || '').split(path.delimiter);
	const nodeNames = process.platform === 'win32' ? ['node.exe'] : ['node'];
	const installer = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'handide');
	const shim = findIn([installer, ...pathDirs], process.platform === 'win32' ? ['handide.cmd'] : ['handide']);
	if (!shim) return null;
	const dir = path.dirname(shim);
	// installer/handide.cmd: <dir>\node\node.exe <dir>\app\proxy\server.mjs
	const bundled = { node: path.join(dir, 'node', nodeNames[0]), server: path.join(dir, 'app', 'proxy', 'server.mjs') };
	if (fs.existsSync(bundled.node) && fs.existsSync(bundled.server)) return bundled;
	// npm: the shim next to node_modules (Windows), or a link into it (macOS, Linux)
	let server = path.join(dir, 'node_modules', 'handide', 'proxy', 'server.mjs');
	if (!fs.existsSync(server)) {
		try {
			server = fs.realpathSync(shim);
		} catch {
			return null;
		}
	}
	const node = findIn([dir, ...pathDirs], nodeNames);
	return node && fs.existsSync(server) ? { node, server } : null;
}

/** Runs the handide command; resolves to the JSON of its last output line. */
function handide(args, timeout = 30_000) {
	const c = locateHandide() ?? bundledReady();
	if (!c) return Promise.reject(new Error('handide is not set up on this PC yet: press the phone button in the status bar once'));
	return new Promise((ok, fail) => {
		execFile(c.node, [c.server, ...args], { timeout, windowsHide: true, maxBuffer: 16 << 20 }, (err, out, errOut) => {
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

// ---------------------------------------------------------------- open on the phone

const handidePort = () => vscode.workspace.getConfiguration('handide').get('port') ?? 9000;
const START_LOG = path.join(os.tmpdir(), 'handide-from-editor.log');
const START_WAIT_MS = 180_000; // the first run may download the editor server

const failure = (code, message) => Object.assign(new Error(message), { code });
const STARTED = 'handide.started'; // globalState: { pid, port } of the handide this editor started
let extContext;

/** The running handide's links opening `folder`, each with its QR code (proxy/connect.mjs: connectJson). */
function connectInfo(folder) {
	const port = handidePort();
	return new Promise((ok, fail) => {
		const req = http.get(
			// Only served to this PC under a localhost name (proxy/connect.mjs: isConnectAllowed).
			{ host: '127.0.0.1', port, path: `/__handide/connect.json?folder=${encodeURIComponent(folder)}`, headers: { host: `localhost:${port}` }, timeout: 5_000 },
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (body += c));
				res.on('end', () => {
					if (res.statusCode === 503) return fail(failure('STARTING', 'handide is still starting'));
					try {
						const info = JSON.parse(body);
						if (info.ok) return ok(info);
					} catch {
						// not handide's JSON: below
					}
					fail(failure('OLD', `something on port ${port} does not answer as a current handide. If it is an older handide, stop it, update it ("npm install -g github:YangJongWon/handide") and try again.`));
				});
			},
		);
		req.on('timeout', () => req.destroy(failure('ETIMEDOUT', `handide on port ${port} does not answer`)));
		req.on('error', fail);
	});
}

/**
 * Starts handide on `folder`, detached so it outlives this window and the phone keeps
 * working when the editor closes. Resolves once it answers; its output goes to START_LOG.
 */
async function startHandide(folder, progress) {
	let found = locateHandide();
	if (!found) {
		try {
			found = await bundledHandide((message) => progress.report({ message }));
		} catch (err) {
			throw failure('SETUP', `could not set up handide: ${err.message}`);
		}
	}
	if (!found) throw failure('NOT_FOUND', 'handide is not installed on this PC.');
	const out = fs.openSync(START_LOG, 'w');
	const port = handidePort();
	const child = spawn(found.node, [found.server, folder, '--port', String(port)], {
		cwd: folder,
		detached: true,
		stdio: ['ignore', out, out],
		windowsHide: true,
	});
	fs.closeSync(out);
	let exited = null;
	child.on('error', (err) => (exited = err.message));
	child.on('exit', (code) => (exited = `exit code ${code}`));
	child.unref();
	if (child.pid) await extContext.globalState.update(STARTED, { pid: child.pid, port });
	progress.report({ message: 'starting handide…' });
	for (const until = Date.now() + START_WAIT_MS; Date.now() < until; ) {
		await new Promise((r) => setTimeout(r, 1_000));
		if (exited !== null) throw failure('EXITED', `handide stopped (${exited}).`);
		try {
			return await connectInfo(folder);
		} catch (err) {
			if (err.code === 'OLD') throw err;
		}
	}
	throw failure('EXITED', 'handide did not start in time.');
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
};

/** The handide this editor started, while it runs. */
function startedHandide() {
	const started = extContext.globalState.get(STARTED);
	return started && alive(started.pid) ? started : null;
}

/** Stops `started` with its editor server and everything else it started; resolves once its port is free. */
async function killHandide(started) {
	if (process.platform === 'win32') spawn('taskkill', ['/pid', String(started.pid), '/T', '/F'], { windowsHide: true });
	else process.kill(-started.pid, 'SIGTERM'); // detached: its own process group
	await extContext.globalState.update(STARTED, undefined);
	for (const until = Date.now() + 15_000; Date.now() < until; ) {
		await new Promise((r) => setTimeout(r, 500));
		if (!(await connectInfo('').then(() => true, (err) => !notRunning(err)))) return;
	}
}

/** Stops the handide this editor started (one started in a terminal stops with Ctrl+C there). */
async function stopHandide() {
	const started = startedHandide();
	if (!started) {
		await extContext.globalState.update(STARTED, undefined);
		return vscode.window.showInformationMessage('handide: no handide started from the editor is running. One started in a terminal stops with Ctrl+C there.');
	}
	await killHandide(started);
	phonePanel?.dispose();
	vscode.window.showInformationMessage('handide: stopped. The phone button starts it again.');
}

/**
 * "handide remote" in a terminal of this editor: installs Tailscale when missing, signs in
 * and allows the address from anywhere, asking in the browser where it must. A real
 * terminal, since an installer may ask for a password there. Then handide starts again
 * to publish the address: it only tries when it starts.
 */
async function setupRemote() {
	let found = locateHandide();
	if (!found) {
		try {
			found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'handide' }, (progress) =>
				bundledHandide((message) => progress.report({ message })),
			);
		} catch (err) {
			return vscode.window.showErrorMessage(`handide: could not set up handide: ${err.message}`);
		}
	}
	if (!found) return vscode.window.showErrorMessage('handide: handide is not installed on this PC.');
	const terminal = vscode.window.createTerminal({
		name: 'handide: access from anywhere',
		shellPath: found.node,
		shellArgs: [found.server, 'remote'],
		iconPath: new vscode.ThemeIcon('globe'),
	});
	terminal.show();
	// The terminal stays open after the run so its output can be read; exitStatus says how it went.
	const timer = setInterval(async () => {
		if (!terminal.exitStatus) return;
		clearInterval(timer);
		if (terminal.exitStatus.code !== 0) return;
		const started = startedHandide();
		if (started) {
			const restart = 'Restart handide';
			const pick = await vscode.window.showInformationMessage('handide: access from anywhere is set up. Restart handide to add the link from anywhere?', restart);
			if (pick !== restart) return;
			await killHandide(started);
			await openOnPhone();
		} else if (await connectInfo('').then(() => true, () => false)) {
			vscode.window.showInformationMessage('handide: access from anywhere is set up. Restart the handide that is running (it was not started from the editor) to add the link from anywhere.');
		} else {
			vscode.window.showInformationMessage('handide: access from anywhere is set up. The phone button now shows a link that works anywhere.');
		}
	}, 1_000);
}

/** Nothing listens on the port, so starting handide there is the fix. */
const notRunning = (err) => err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function phoneHtml(info, folder, webview) {
	const nonce = crypto.randomBytes(18).toString('base64');
	const links = info.links;
	const remote = links[0]?.remote;
	const lead = !links.length
		? info.local
			? 'handide runs for this PC only (--local), so there is no link for the phone. Stop it and start it without --local.'
			: 'handide found no network address on this PC. Check that it is on Wi-Fi or wired, then start handide again.'
		: !remote
			? 'The phone needs to be on the same Wi-Fi as this PC.'
			: links[0].public
				? 'Works at home and away; nothing to install on the phone.'
				: 'Works anywhere while the Tailscale app is on on the phone (same account as this PC).';
	// Why there is no link from anywhere (proxy/tailscale.mjs: startTailscale); null from an older handide.
	const status = info.remote ?? { code: 'unknown' };
	const why = {
		pending: 'Getting the link that works anywhere… (the first time, Tailscale may ask in the browser).',
		'not-installed': 'Away from home: Tailscale is not installed on this PC.',
		'signed-out': 'Away from home: Tailscale is signed out on this PC.',
		'not-running': 'Away from home: Tailscale is not running on this PC.',
		failed: `Away from home: no link (${status.reason ?? 'Tailscale failed'}).`,
		taken: `Away from home: ${status.reason}. Stop that handide to give this one the address.`,
		unknown: 'Away from home: not set up.',
	}[status.code];
	const canSetUp = ['not-installed', 'signed-out', 'not-running', 'failed', 'unknown'].includes(status.code);
	const awayNote = links.length && !remote && why
		? `<div class="away"><p>${escapeHtml(why)}</p>${canSetUp ? '<button type="button" class="setup">Set up access from anywhere</button>' : ''}</div>`
		: '';
	const tabs = links
		.map((l, i) => `<button type="button" class="tab" data-i="${i}" aria-selected="${i === 0}">${escapeHtml(l.label)} · ${escapeHtml(new URL(l.url).hostname)}</button>`)
		.join('');
	// The SVGs come from handide on this PC (proxy/connect.mjs: connectJson).
	const panels = links
		.map(
			(l, i) => `<section class="panel" data-i="${i}"${i ? ' hidden' : ''}>
				<div class="qr">${l.svg}</div>
				<div class="link"><code>${escapeHtml(l.url)}</code><button type="button" class="copy" data-url="${escapeHtml(l.url)}">Copy</button></div>
			</section>`,
		)
		.join('');
	const notes = [
		links.some((l) => !l.remote) && info.selfSigned
			? '<li>The first visit on a LAN address shows a certificate warning (handide made the certificate for this PC). Android Chrome: <i>Advanced</i> → <i>Proceed</i>. iPhone Safari: <i>Show Details</i> → <i>visit this website</i>.</li>'
			: '',
		'<li>When VS Code asks whether to trust the folder, trust it: the mobile tabs and agent extensions need it.</li>',
		'<li>handide keeps running after this editor closes, so the phone stays connected. <b>handide: Stop</b> in the Command Palette stops it.</li>',
	].join('');
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
	main { max-width: 480px; margin: 0 auto; padding: 24px 12px; }
	h1 { font-size: 1.6em; margin: 0 0 4px; }
	.folder { color: var(--vscode-descriptionForeground); margin: 0 0 12px; overflow-wrap: anywhere; }
	.lead { margin: 0 0 16px; }
	.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
	.tab { border: 1px solid var(--vscode-panel-border); background: none; color: inherit; border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; }
	.tab[aria-selected="true"] { border-color: var(--vscode-focusBorder); color: var(--vscode-textLink-foreground); font-weight: 600; }
	.qr { background: #fff; border-radius: 12px; padding: 12px; width: min(100%, 360px); margin: 0 auto 12px; }
	.qr svg { display: block; width: 100%; height: auto; }
	.link { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
	.link code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .9em; }
	.copy { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; font: inherit; }
	ul { padding-left: 18px; color: var(--vscode-descriptionForeground); }
	li { margin-bottom: 6px; }
	.note { color: var(--vscode-descriptionForeground); font-size: .9em; }
	.away { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px 12px; margin: 0 0 16px; }
	.away p { margin: 0 0 8px; }
	.away p:last-child { margin: 0; }
	.setup { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 6px 12px; cursor: pointer; font: inherit; }
</style>
</head>
<body>
<main>
	<h1>${links.length ? 'Scan with your phone camera' : 'No link for the phone'}</h1>
	<p class="folder">${escapeHtml(folder)}</p>
	<p class="lead">${escapeHtml(lead)}</p>
	${links.length > 1 ? `<div class="tabs">${tabs}</div>` : ''}
	${panels}
	${awayNote}
	${links.length ? `<ul>${notes}</ul><p class="note">The link contains your access token: use it only on your own devices.</p>` : ''}
</main>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	for (const b of document.querySelectorAll('.tab')) {
		b.addEventListener('click', () => {
			for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t === b));
			for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.i !== b.dataset.i;
		});
	}
	document.querySelector('.setup')?.addEventListener('click', () => vscode.postMessage({ setupRemote: true }));
	for (const c of document.querySelectorAll('.copy')) {
		c.addEventListener('click', () => {
			vscode.postMessage({ copy: c.dataset.url });
			c.textContent = 'Copied';
			setTimeout(() => (c.textContent = 'Copy'), 1500);
		});
	}
</script>
</body>
</html>`;
}

let phonePanel = null;

/** Renders the panel again only when the links changed, so a picked tab stays picked. */
function showPhone(info, folder) {
	const key = JSON.stringify([folder, info.links.map((l) => l.url), info.local, info.remote?.code]);
	if (phonePanel.key === key) return;
	phonePanel.key = key;
	phonePanel.folder = folder;
	phonePanel.webview.html = phoneHtml(info, folder, phonePanel.webview);
}

/** Shows the QR code for this window's folder; the away-from-home link joins it once handide has it. */
async function openOnPhone() {
	const uri = folderUri();
	if (!uri || uri.scheme !== 'file') {
		return vscode.window.showInformationMessage('handide: open a folder on this PC first; that project then opens on the phone.');
	}
	const folder = uri.fsPath;
	let info;
	try {
		info = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'handide' }, async (progress) => {
			try {
				return await connectInfo(folder);
			} catch (err) {
				if (!notRunning(err)) throw err;
				return startHandide(folder, progress);
			}
		});
	} catch (err) {
		if (err.code === 'NOT_FOUND') {
			const how = 'How to install';
			const pick = await vscode.window.showErrorMessage(`handide: ${err.message} Install it, then press the phone button again.`, how);
			if (pick === how) await vscode.env.openExternal(vscode.Uri.parse('https://github.com/YangJongWon/handide#quick-start'));
			return;
		}
		if (err.code !== 'EXITED') return vscode.window.showErrorMessage(`handide: ${err.message}`);
		const log = 'Show log';
		const pick = await vscode.window.showErrorMessage(`handide: ${err.message} The log says why.`, log);
		if (pick === log) await vscode.window.showTextDocument(vscode.Uri.file(START_LOG));
		return;
	}

	if (phonePanel) phonePanel.reveal(vscode.ViewColumn.Active);
	else {
		const panel = vscode.window.createWebviewPanel('handide.phone', 'Open on Phone', vscode.ViewColumn.Active, { enableScripts: true });
		phonePanel = panel;
		panel.iconPath = new vscode.ThemeIcon('device-mobile');
		panel.webview.onDidReceiveMessage((m) => {
			if (m?.copy) vscode.env.clipboard.writeText(String(m.copy));
			if (m?.setupRemote) setupRemote();
		});
		// The away-from-home link comes after the LAN one (tunnels take a while), and a
		// restarted handide may have other addresses.
		const timer = setInterval(async () => {
			if (!panel.visible) return;
			const next = await connectInfo(panel.folder).catch(() => null);
			if (next && phonePanel === panel) showPhone(next, panel.folder);
		}, 5_000);
		panel.onDidDispose(() => {
			clearInterval(timer);
			if (phonePanel === panel) phonePanel = null;
		});
	}
	showPhone(info, folder);
}

function activate(context) {
	extContext = context;
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
	const phone = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	phone.command = 'handide.openOnPhone';
	phone.text = '$(device-mobile)';
	phone.tooltip = 'handide: open this project on your phone (QR code)';
	const togglePhone = () => (folderUri()?.scheme === 'file' ? phone.show() : phone.hide());
	togglePhone();
	context.subscriptions.push(
		item,
		phone,
		vscode.workspace.onDidChangeWorkspaceFolders(togglePhone),
		vscode.commands.registerCommand('handide.openOnPhone', openOnPhone),
		vscode.commands.registerCommand('handide.stop', stopHandide),
		vscode.commands.registerCommand('handide.setupRemote', setupRemote),
		vscode.commands.registerCommand('handide.openOnPC', openOnPC),
		vscode.commands.registerCommand('handide.switch', () => switchMenu(context)),
	);
	restorePending(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
