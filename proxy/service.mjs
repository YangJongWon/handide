// "handide service": runs handide at logon and starts it again whenever it exits, so a
// PC that crashed, or whose editor server stopped answering (editor.mjs: watchServeWeb),
// is back within a minute without anyone at it. One PC down then never takes the others
// down: the phone opens each PC at its own address (layer/mobile.js, layer/sw.js).
//
//   Windows: a script in the Startup folder that loops (no administrator rights, no window)
//   macOS:   a launchd agent with KeepAlive
//   Linux:   a systemd user service with Restart=always
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const LABEL = 'com.handide';
const WAIT_MS = 5_000; // before starting again
const WAIT_FAST_EXIT_MS = 60_000; // after a run shorter than a minute, so a broken start does not spin

const startupScript = () => join(process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'handide.vbs');
const launchAgent = () => join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const systemdUnit = () => join(os.homedir(), '.config', 'systemd', 'user', 'handide.service');
const run = (cmd, args) => spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8' });

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function windowsScript({ command, folder, dataDir }) {
	// Inside a VBScript string a quote is doubled; cmd.exe then sees each argument quoted.
	const q = (s) => `""${s}""`;
	const log = join(dataDir, 'handide.log');
	const err = join(dataDir, 'handide.err.log');
	const cmd = `cmd.exe /c cd /d ${q(folder)} && echo [%date% %time%] handide start >> ${q(err)} && ${command.map(q).join(' ')} > ${q(log)} 2>> ${q(err)}`;
	return `' handide service ("handide service install"): serves VS Code to the phone and starts
' it again whenever it exits: after ${WAIT_MS / 1000} seconds, or after ${WAIT_FAST_EXIT_MS / 1000} if it ran for less than
' a minute. "handide service uninstall" stops it and removes this file.
' Log: ${log} (current run)
'      ${err} (all runs, with start times)
Dim sh, started
Set sh = CreateObject("Wscript.Shell")
Do
	started = Timer
	sh.Run "${cmd}", 0, True
	If Abs(Timer - started) < 60 Then WScript.Sleep ${WAIT_FAST_EXIT_MS} Else WScript.Sleep ${WAIT_MS}
Loop
`;
}

function macPlist({ command, folder, dataDir }) {
	const args = command.map((a) => `\t\t<string>${xml(a)}</string>`).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>WorkingDirectory</key>
	<string>${xml(folder)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>${WAIT_FAST_EXIT_MS / 1000}</integer>
	<key>StandardOutPath</key>
	<string>${xml(join(dataDir, 'handide.log'))}</string>
	<key>StandardErrorPath</key>
	<string>${xml(join(dataDir, 'handide.err.log'))}</string>
</dict>
</plist>
`;
}

function linuxUnit({ command, folder }) {
	const quote = (a) => `"${a.replace(/(["\\])/g, '\\$1')}"`;
	return `[Unit]
Description=handide: VS Code on the phone
After=network-online.target

[Service]
ExecStart=${command.map(quote).join(' ')}
WorkingDirectory=${folder}
Environment=${quote(`PATH=${process.env.PATH ?? '/usr/bin:/bin'}`)}
Restart=always
RestartSec=${WAIT_MS / 1000}

[Install]
WantedBy=default.target
`;
}

/** Ends the Startup script's loop and everything under it (handide, its editor server). */
function stopWindows() {
	const r = run('powershell.exe', [
		'-NoProfile',
		'-Command',
		"Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\" | Where-Object { $_.CommandLine -match 'handide\\.vbs' } | ForEach-Object { $_.ProcessId }",
	]);
	const pids = (r.stdout || '').split(/\s+/).filter(Boolean);
	for (const pid of pids) run('taskkill', ['/pid', pid, '/T', '/F']);
	return pids.length;
}

const uid = () => process.getuid?.() ?? 0;

async function install({ command, folder, dataDir, log }) {
	await mkdir(dataDir, { recursive: true });
	if (process.platform === 'win32') {
		if (command.some((a) => a.includes('"'))) throw new Error('a path or option with a quote (") cannot go in the Startup script');
		const file = startupScript();
		const stopped = stopWindows();
		await writeFile(file, windowsScript({ command, folder, dataDir }));
		spawn('wscript.exe', [file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
		log(`${stopped ? 'restarted' : 'started'}; runs at logon from ${file}`);
	} else if (process.platform === 'darwin') {
		const file = launchAgent();
		await mkdir(join(os.homedir(), 'Library', 'LaunchAgents'), { recursive: true });
		run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
		await writeFile(file, macPlist({ command, folder, dataDir }));
		const r = run('launchctl', ['bootstrap', `gui/${uid()}`, file]);
		if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || '').trim()}`);
		log(`started; runs at logon from ${file}`);
	} else {
		const file = systemdUnit();
		await mkdir(join(os.homedir(), '.config', 'systemd', 'user'), { recursive: true });
		await writeFile(file, linuxUnit({ command, folder }));
		run('systemctl', ['--user', 'daemon-reload']);
		const r = run('systemctl', ['--user', 'enable', '--now', 'handide.service']);
		if (r.status !== 0) throw new Error(`systemctl failed: ${(r.stderr || '').trim()}`);
		run('systemctl', ['--user', 'restart', 'handide.service']);
		log(`started; runs at logon from ${file}`);
		log(`to run it before anyone logs in too: loginctl enable-linger ${os.userInfo().username}`);
	}
	log(`log: ${join(dataDir, 'handide.log')}`);
}

async function uninstall({ log }) {
	if (process.platform === 'win32') {
		const stopped = stopWindows();
		await rm(startupScript(), { force: true });
		log(stopped ? 'stopped and removed' : 'removed (it was not running)');
	} else if (process.platform === 'darwin') {
		run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
		await rm(launchAgent(), { force: true });
		log('stopped and removed');
	} else {
		run('systemctl', ['--user', 'disable', '--now', 'handide.service']);
		await rm(systemdUnit(), { force: true });
		run('systemctl', ['--user', 'daemon-reload']);
		log('stopped and removed');
	}
}

function status({ log }) {
	if (process.platform === 'win32') {
		const file = startupScript();
		if (!existsSync(file)) return log('not installed ("handide service install" sets it up)');
		const r = run('powershell.exe', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\" | Where-Object { $_.CommandLine -match 'handide\\.vbs' }).Count"]);
		log(`installed (${file}); ${Number(r.stdout) > 0 ? 'running' : 'not running: log off and on, or run "handide service install" again'}`);
	} else if (process.platform === 'darwin') {
		if (!existsSync(launchAgent())) return log('not installed ("handide service install" sets it up)');
		const r = run('launchctl', ['print', `gui/${uid()}/${LABEL}`]);
		log(`installed (${launchAgent()}); ${/state = running/.test(r.stdout || '') ? 'running' : 'not running'}`);
	} else {
		if (!existsSync(systemdUnit())) return log('not installed ("handide service install" sets it up)');
		const r = run('systemctl', ['--user', 'is-active', 'handide.service']);
		log(`installed (${systemdUnit()}); ${(r.stdout || '').trim() || 'unknown'}`);
	}
}

/**
 * handide service install [folder] [options] | uninstall | status. `run` is how handide
 * itself is started: node, this server.mjs, the folder and the options as given.
 */
export async function serviceCommand(args, { run: command, folder, dataDir, log }) {
	const [action = 'status'] = args;
	if (action === 'install') return install({ command, folder, dataDir, log });
	if (action === 'uninstall') return uninstall({ log });
	if (action === 'status') return status({ log });
	throw new Error('usage: handide service install [folder] [options] | uninstall | status');
}
