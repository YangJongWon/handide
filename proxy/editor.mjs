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

/**
 * Starts `serve-web` on localhost only; the proxy is the sole public entry point.
 * Resolves once the CLI prints its "Web UI available" line.
 */
export function startServeWeb({ cli, port, token, dataDir, folder, log }) {
	const args = [
		'serve-web',
		'--host', '127.0.0.1',
		'--port', String(port),
		'--connection-token', token,
		'--accept-server-license-terms',
		'--disable-telemetry',
		'--server-data-dir', dataDir,
	];
	if (folder) args.push('--default-folder', folder);
	const child = spawn(cli, args, {
		shell: process.platform === 'win32' && !cli.endsWith('.exe'),
		windowsHide: true,
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
