// Opening another PC's project in the desktop editor (VS Code or Cursor, Remote - SSH),
// so it runs where it lives: git, terminals, language servers and agents of that PC.
// handide sets up what that needs between this account's PCs, over the tailnet:
//
//   - a key of its own per PC (<data dir>/ssh/id_ed25519), handed to the other PCs when
//     they pair (proxy/devices.mjs) and added to their ~/.ssh/authorized_keys, usable
//     from tailnet addresses only;
//   - the other PCs' host keys, pinned from pairing, so the first connection asks nothing;
//   - Host entries "handide-<pc>" in <data dir>/ssh/config, included from ~/.ssh/config.
//
// The SSH server itself is turned on once per PC with "handide ssh" (administrator rights).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const HOST_PREFIX = 'handide-';
const KEY_LINE = /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+$/;
const MARK = 'handide:'; // comment on the keys handide adds, to find them again
// Keys handide adds log in only from tailnet addresses (Tailscale's IPv4 and IPv6 ranges):
// they come from pairing, which only a device of this account on the tailnet can do, and
// the other PCs reach this one over the tailnet. A copy of the key elsewhere is no use.
const FROM_TAILNET = 'from="100.64.0.0/10,fd7a:115c:a1e0::/48"';

const sshDir = (dataDir) => join(dataDir, 'ssh');
const keyFile = (dataDir) => join(sshDir(dataDir), 'id_ed25519');
const hostAlias = (name) => `${HOST_PREFIX}${name}`;

/** This PC's handide key (made once); resolves to its public line "ssh-ed25519 AAAA…". */
export async function ensureKey(dataDir) {
	const file = keyFile(dataDir);
	if (!existsSync(file)) {
		await mkdir(sshDir(dataDir), { recursive: true });
		const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-C', `handide@${os.hostname()}`, '-f', file], { windowsHide: true, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`ssh-keygen failed: ${(r.stderr || r.error?.message || '').trim()}`);
	}
	return (await readFile(`${file}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
}

const hostKeyDir = () => (process.platform === 'win32' ? join(process.env.ProgramData || 'C:\\ProgramData', 'ssh') : '/etc/ssh');

/** Whether something listens on port 22 here. */
export function sshServerOn() {
	return new Promise((ok) => {
		const s = net.connect(22, '127.0.0.1');
		const done = (v) => {
			s.destroy();
			ok(v);
		};
		s.once('connect', () => done(true));
		s.once('error', () => done(false));
		s.setTimeout(1500, () => done(false));
	});
}

/** What another PC needs to reach this one over SSH: no secrets. */
export async function sshInfo() {
	const hostKeys = [];
	for (const t of ['ed25519', 'ecdsa', 'rsa']) {
		try {
			const line = readFileSync(join(hostKeyDir(), `ssh_host_${t}_key.pub`), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
			if (KEY_LINE.test(line)) hostKeys.push(line);
		} catch {
			// not generated (no server yet) or not readable
		}
	}
	// cli: how to run handide there over SSH (a non-interactive shell may not have it on PATH).
	const cli = { node: process.execPath, server: fileURLToPath(new URL('./server.mjs', import.meta.url)) };
	return { user: os.userInfo().username, platform: process.platform, home: os.homedir(), server: await sshServerOn(), hostKeys, cli };
}

/** Lets the key of another PC of this account log in here (~/.ssh/authorized_keys). */
export async function authorizeKey(key, name) {
	if (!KEY_LINE.test(key)) throw new Error('not an SSH public key');
	const dir = join(os.homedir(), '.ssh');
	const file = join(dir, 'authorized_keys');
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const lines = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
	const comment = `${MARK}${name}`;
	const wanted = `${FROM_TAILNET} ${key} ${comment}`;
	const ours = (l) => l.trim().endsWith(` ${comment}`);
	if (lines.some((l) => l.includes(key) && (!ours(l) || l === wanted))) return false; // already allowed (by handide or by hand)
	// One key per PC: a new key from the same PC replaces its old one (and one handide
	// added before keys were limited to the tailnet gets the limit).
	const kept = lines.filter((l) => !ours(l));
	await writeFile(file, [...kept, wanted].join('\n') + '\n', { mode: 0o600 });
	if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => {});
	return true;
}

/** "c:\Users\x" → "/c:/Users/x"; POSIX paths stay. The path part of a remote folder URI. */
export const remotePath = (p) => (/^[a-zA-Z]:[\\/]/.test(p) ? `/${p.replaceAll('\\', '/')}` : p);

/** Host entries "handide-<pc>" for the other PCs, with their host keys pinned from pairing. */
export async function writeClientConfig(dataDir, devices) {
	const dir = sshDir(dataDir);
	await mkdir(dir, { recursive: true });
	const knownHosts = join(dir, 'known_hosts');
	const quote = (p) => `"${p.replaceAll('\\', '/')}"`;
	const blocks = [];
	const known = [];
	for (const d of devices) {
		if (!d.ssh?.user) continue;
		const host = new URL(d.url).hostname.replace(/^\[|\]$/g, '');
		blocks.push(
			[
				`Host ${hostAlias(d.name)}`,
				`\tHostName ${host}`,
				`\tUser ${d.ssh.user}`,
				`\tIdentityFile ${quote(keyFile(dataDir))}`,
				'\tIdentitiesOnly yes',
				`\tHostKeyAlias ${hostAlias(d.name)}`,
				`\tUserKnownHostsFile ${quote(knownHosts)}`,
				// Pinned from pairing when the server was on then; otherwise learned on first use.
				`\tStrictHostKeyChecking ${d.ssh.hostKeys?.length ? 'yes' : 'accept-new'}`,
			].join('\n'),
		);
		for (const k of d.ssh.hostKeys ?? []) known.push(`${hostAlias(d.name)} ${k}`);
	}
	const config = join(dir, 'config');
	await writeFile(config, `# Written by handide: the other PCs of this account. Included from ~/.ssh/config by "handide ssh".\n\n${blocks.join('\n\n')}\n`);
	// Pinned PCs are rewritten; keys learned with accept-new for the others are kept.
	const pinned = new Set(devices.filter((d) => d.ssh?.hostKeys?.length).map((d) => hostAlias(d.name)));
	const learned = (await readFile(knownHosts, 'utf8').catch(() => '')).split(/\r?\n/).filter((l) => l && !pinned.has(l.split(' ')[0]));
	await writeFile(knownHosts, [...new Set([...known, ...learned])].join('\n') + '\n');
	return config;
}

/** Includes handide's Host entries from ~/.ssh/config (once, at the top: Include only applies before the first Host line). */
export async function includeClientConfig(dataDir) {
	const config = join(sshDir(dataDir), 'config');
	const quote = (p) => `"${p.replaceAll('\\', '/')}"`;
	const userDir = join(os.homedir(), '.ssh');
	const userConfig = join(userDir, 'config');
	const include = `Include ${quote(config)}`;
	const current = await readFile(userConfig, 'utf8').catch(() => '');
	if (!current.split(/\r?\n/).some((l) => l.trim() === include)) {
		await mkdir(userDir, { recursive: true, mode: 0o700 });
		await writeFile(userConfig, `${include}\n${current ? `\n${current}` : ''}`, { mode: 0o600 });
		return true;
	}
	return false;
}

// ---------------------------------------------------------------- server

const WINDOWS_SETUP = `$ErrorActionPreference = 'Stop'
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
# Administrators' keys would go to C:\\ProgramData\\ssh\\administrators_authorized_keys, which
# handide (not elevated) cannot write: use ~/.ssh/authorized_keys for everyone.
$cfg = Join-Path $env:ProgramData 'ssh\\sshd_config'
$lines = Get-Content $cfg
$out = $lines | ForEach-Object { if ($_ -match '^\\s*Match Group administrators' -or $_ -match '^\\s*AuthorizedKeysFile\\s+__PROGRAMDATA__') { '#' + $_ } else { $_ } }
Set-Content -Path $cfg -Value $out -Encoding ascii
Restart-Service sshd
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
`;

function runInherit(cmd, args) {
	return new Promise((ok) => {
		const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: false });
		child.on('error', () => ok(-1));
		child.on('close', (code) => ok(code));
	});
}

/** Turns the SSH server on here (asks for administrator rights). Resolves to true when it is on. */
export async function enableServer(log) {
	if (await sshServerOn()) return true;
	if (process.platform === 'win32') {
		const script = join(os.tmpdir(), 'handide-sshd-setup.ps1');
		await writeFile(script, WINDOWS_SETUP);
		log('Windows asks for administrator rights to turn on the OpenSSH server: choose Yes.');
		await runInherit('powershell.exe', [
			'-NoProfile',
			'-Command',
			`Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}'`,
		]);
	} else if (process.platform === 'darwin') {
		log('Turning on Remote Login (your Mac password is asked)...');
		await runInherit('sudo', ['launchctl', 'load', '-w', '/System/Library/LaunchDaemons/ssh.plist']);
		if (!(await sshServerOn())) {
			log('Turn on "Remote Login" in the System Settings page that opens (General > Sharing), then run "handide ssh" again.');
			spawn('open', ['x-apple.systempreferences:com.apple.Sharing-Settings.extension'], { detached: true, stdio: 'ignore' }).unref();
		}
	} else {
		await runInherit('sudo', ['sh', '-c', 'systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd']);
	}
	for (let i = 0; i < 10 && !(await sshServerOn()); i++) await new Promise((r) => setTimeout(r, 1000));
	return sshServerOn();
}
