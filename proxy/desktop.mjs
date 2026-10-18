// "handide ssh" and "handide desktop": the setup for opening other PCs' projects in the
// desktop editor (desktop/extension.js, proxy/ssh.mjs).
//
//   handide ssh       on each PC, once: SSH server on (administrator rights), key, Host entries
//   handide desktop   on the PC whose editor you use: the extension in VS Code and Cursor,
//                     and Remote - SSH where it is missing
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { describeDevices, loadDevices } from './devices.mjs';
import { enableServer, ensureKey, includeClientConfig, sshServerOn, writeClientConfig } from './ssh.mjs';

const DESKTOP_DIR = new URL('../desktop/', import.meta.url);

/** The desktop editors installed here, with the extension each one uses for Remote - SSH. */
function desktopEditors() {
	const local = process.env.LOCALAPPDATA || '';
	const programs = process.env.ProgramFiles || 'C:\\Program Files';
	const list =
		process.platform === 'win32'
			? [
					{ name: 'VS Code', remoteSSH: 'ms-vscode-remote.remote-ssh', clis: [join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), join(programs, 'Microsoft VS Code', 'bin', 'code.cmd')] },
					{ name: 'Cursor', remoteSSH: 'anysphere.remote-ssh', clis: [join(local, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')] },
				]
			: process.platform === 'darwin'
				? [
						{ name: 'VS Code', remoteSSH: 'ms-vscode-remote.remote-ssh', clis: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')] },
						{ name: 'Cursor', remoteSSH: 'anysphere.remote-ssh', clis: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', join(os.homedir(), 'Applications/Cursor.app/Contents/Resources/app/bin/cursor')] },
					]
				: [
						{ name: 'VS Code', remoteSSH: 'ms-vscode-remote.remote-ssh', clis: ['/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code'] },
						{ name: 'Cursor', remoteSSH: 'anysphere.remote-ssh', clis: ['/usr/bin/cursor', '/opt/cursor/resources/app/bin/cursor'] },
					];
	return list.map((e) => ({ ...e, cli: e.clis.find((c) => existsSync(c)) })).filter((e) => e.cli);
}

const runCli = (cli, args) =>
	spawnSync(cli, args, { encoding: 'utf8', timeout: 180_000, windowsHide: true, shell: process.platform === 'win32' && cli.endsWith('.cmd') });

// ---------------------------------------------------------------- vsix (a zip, stored)

function crc32(buf) {
	let crc = 0xffffffff;
	for (const byte of buf) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of [name, Buffer] entries without compression: all a .vsix needs. */
function zip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const n = Buffer.from(name, 'utf8');
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(0, 8); // stored
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x21, 12); // 1980-01-01
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(n.length, 26);
		local.writeUInt16LE(0, 28);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0x21, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(n.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, n, data);
		centrals.push(central, n);
		offset += local.length + n.length + data.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** desktop/ as a .vsix, with handide.json saying how to run this handide. */
async function buildVsix(dataDir, serverPath) {
	const manifest = JSON.parse(await readFile(new URL('package.json', DESKTOP_DIR), 'utf8'));
	const files = [];
	for (const name of await readdir(DESKTOP_DIR)) files.push([`extension/${name}`, await readFile(new URL(name, DESKTOP_DIR))]);
	files.push(['extension/handide.json', Buffer.from(JSON.stringify({ node: process.execPath, server: serverPath }, null, '\t'))]);
	const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}" />
		<DisplayName>${xml(manifest.displayName)}</DisplayName>
		<Description xml:space="preserve">${xml(manifest.description)}</Description>
		<Properties>
			<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
		</Properties>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code" />
	</Installation>
	<Dependencies />
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
	</Assets>
</PackageManifest>
`;
	const types = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>';
	const out = join(dataDir, 'desktop', `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`);
	await mkdir(join(dataDir, 'desktop'), { recursive: true });
	await writeFile(out, zip([['[Content_Types].xml', Buffer.from(types)], ['extension.vsixmanifest', Buffer.from(vsixManifest)], ...files]));
	return { file: out, id: `${manifest.publisher}.${manifest.name}` };
}

// ---------------------------------------------------------------- commands

/** Key, Host entries for the PCs paired so far, and their Include in ~/.ssh/config. */
async function clientSetup(dataDir, log) {
	await ensureKey(dataDir);
	const pcs = await describeDevices(dataDir); // pairs again: hands the key to the PCs that are on
	await writeClientConfig(dataDir, await loadDevices(dataDir));
	if (await includeClientConfig(dataDir)) log('~/.ssh/config: added an Include of handide\'s Host entries (handide-<pc>) at the top.');
	return pcs;
}

function reportPCs(pcs, log) {
	if (!pcs.length) return log('No other PCs yet: run "handide" on them, signed in to Tailscale with the same account.');
	for (const p of pcs) {
		const state = !p.online ? 'offline (start handide there)' : !p.host ? 'older handide (update it there)' : p.sshServer ? `ready (ssh ${p.host})` : 'SSH off: run "handide ssh" there once';
		log(`  ${p.name}: ${state}`);
	}
}

/** "handide ssh": this PC can be opened from the others, and can open them. */
export async function sshCommand(args, { dataDir, log }) {
	if (!(await sshServerOn())) {
		if (!(await enableServer(log))) {
			log('The SSH server is not on yet. Other PCs cannot open projects here until it is.');
		}
	}
	if (await sshServerOn()) log('SSH server: on. The other PCs of this account can open projects here.');
	const pcs = await clientSetup(dataDir, log);
	log('Other PCs:');
	reportPCs(pcs, log);
}

/** "handide desktop": the extension in this PC's VS Code and Cursor. */
export async function desktopCommand(args, { dataDir, serverPath, log }) {
	const editors = desktopEditors();
	if (!editors.length) throw new Error('no VS Code or Cursor found on this PC');
	const vsix = await buildVsix(dataDir, serverPath);
	for (const e of editors) {
		const r = runCli(e.cli, ['--install-extension', vsix.file, '--force']);
		log(`${e.name}: ${r.status === 0 ? 'handide extension installed' : `install failed: ${`${r.stderr || r.stdout || r.error?.message || ''}`.trim().split('\n').pop()}`}`);
		const installed = `${runCli(e.cli, ['--list-extensions']).stdout || ''}`.toLowerCase();
		if (!installed.includes(e.remoteSSH)) {
			const s = runCli(e.cli, ['--install-extension', e.remoteSSH]);
			log(`${e.name}: Remote - SSH (${e.remoteSSH}) ${s.status === 0 ? 'installed' : 'could not be installed; install it from the Extensions view'}`);
		}
	}
	const pcs = await clientSetup(dataDir, log);
	log('Open a project on another PC: the "PCs" button in the status bar, or "handide: Open Project on Another PC".');
	log('Other PCs:');
	reportPCs(pcs, log);
}
