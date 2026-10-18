// Finds an installed editor CLI that can serve its own web UI (`serve-web`) and starts it.
// The editor itself is never modified; we only launch it with a private data dir.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

function candidates() {
	const list = [];
	const local = process.env.LOCALAPPDATA;
	if (process.platform === 'win32') {
		for (const base of [local && join(local, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
			if (!base) continue;
			list.push(join(base, 'Microsoft VS Code', 'bin', 'code-tunnel.exe'));
			list.push(join(base, 'Microsoft VS Code Insiders', 'bin', 'code-tunnel-insiders.exe'));
		}
	} else if (process.platform === 'darwin') {
		list.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
		list.push(join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'));
	} else {
		list.push('/usr/share/code/bin/code', '/usr/bin/code', '/snap/bin/code');
	}
	// PATH entries last: `code` may be claimed by a fork (e.g. Cursor) that lacks serve-web.
	list.push('code', 'code-insiders');
	return list;
}

/** True when `cli serve-web --help` looks like the VS Code web server launcher. */
export function supportsServeWeb(cli) {
	if (cli.includes('/') || cli.includes('\\')) {
		if (!existsSync(cli)) return false;
	}
	const r = spawnSync(cli, ['serve-web', '--help'], {
		encoding: 'utf8',
		timeout: 30_000,
		shell: process.platform === 'win32' && !cli.endsWith('.exe'),
		windowsHide: true,
	});
	return /--connection-token/.test(`${r.stdout}${r.stderr}`);
}

export function detectEditorCli(explicit) {
	if (explicit) {
		if (!supportsServeWeb(explicit)) throw new Error(`${explicit} does not support "serve-web"`);
		return explicit;
	}
	for (const cli of candidates()) {
		if (supportsServeWeb(cli)) return cli;
	}
	throw new Error('No editor with "serve-web" found. Install VS Code or pass --editor <path to code CLI>.');
}

export function editorVersion(cli) {
	const r = spawnSync(cli, ['--version'], {
		encoding: 'utf8',
		timeout: 30_000,
		shell: process.platform === 'win32' && !cli.endsWith('.exe'),
		windowsHide: true,
	});
	return `${r.stdout}`.split(/\r?\n/).filter(Boolean).slice(0, 2).join(' ');
}

/** Every process as { pid, ppid, start, cmd }; start is 0 where the platform does not say. */
function listProcesses() {
	if (process.platform === 'win32') {
		const script = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; '
			+ 'start = $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }); cmd = $_.CommandLine } } | ConvertTo-Json -Compress';
		const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
			encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
		});
		try {
			return [JSON.parse(r.stdout)].flat();
		} catch {
			return [];
		}
	}
	const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
	return `${r.stdout}`.split('\n').map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
		.map(([, pid, ppid, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), start: 0, cmd }));
}

/**
 * Stops serve-web servers left on `dataDir` by a handide that did not exit cleanly (its
 * console closed, or it was killed): only a clean exit tears the server tree down, so
 * each crash left one running for good. A server still under a live handide is kept,
 * so a second handide on the same data dir is left alone.
 */
export function stopOrphanedServers(dataDir, log) {
	const procs = listProcesses();
	const byPid = new Map(procs.map((p) => [p.pid, p]));
	const dir = dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const usesDir = new RegExp(`--server-data-dir[ =]"?${dir}(?=["\\s]|$)`, 'i');
	const isHandide = (p) => p.pid === process.pid || /proxy[\\/]server\.mjs/i.test(p.cmd ?? '');

	const roots = new Set();
	for (const p of procs) {
		if (!p.cmd || !usesDir.test(p.cmd)) continue;
		// Walk up the launcher chain (serve-web CLI, cmd, ...) until it reaches a handide.
		// A missing parent, or a parent younger than its child (the pid was reused), ends it.
		let top = p;
		for (;;) {
			if (isHandide(top)) break;
			const parent = top.ppid > 1 && byPid.get(top.ppid);
			if (!parent || parent.pid === top.pid || (top.start && parent.start > top.start)) {
				roots.add(top.pid);
				break;
			}
			top = parent;
		}
	}
	for (const pid of roots) {
		if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
		else {
			try {
				process.kill(pid, 'SIGTERM');
			} catch {
				// already gone
			}
		}
	}
	if (roots.size) log(`stopped ${roots.size} editor server(s) left running by an earlier handide`);
}

/**
 * Starts `serve-web` on localhost only; the proxy is the sole public entry point.
 * Resolves once the CLI prints its "Web UI available" line.
 */
export function startServeWeb({ cli, port, token, dataDir, folder, env, log }) {
	const args = [
		'serve-web',
		'--host', '127.0.0.1',
		'--port', String(port),
		// `=` form: a token starting with "-" would otherwise be parsed as a flag.
		`--connection-token=${token}`,
		'--accept-server-license-terms',
		'--disable-telemetry',
		'--server-data-dir', dataDir,
	];
	if (folder) args.push('--default-folder', folder);
	const child = spawn(cli, args, {
		shell: process.platform === 'win32' && !cli.endsWith('.exe'),
		windowsHide: true,
		// Inherited down to the extension host: tells the companion how to reach the bridge.
		env: { ...process.env, ...env },
	});
	const ready = new Promise((resolve, reject) => {
		const onData = (buf) => {
			const text = buf.toString();
			log(text);
			if (/Web UI available/i.test(text)) resolve(child);
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', (code) => reject(new Error(`serve-web exited with code ${code}`)));
		child.on('error', reject);
	});
	return { child, ready };
}
