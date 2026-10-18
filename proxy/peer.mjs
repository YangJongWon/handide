// `handide peer`: the other PCs' projects from a terminal in the editor, fetched as asked
// (proxy/projects.mjs). It talks to this PC's handide through the bridge's private
// listener, whose address and secret the editor's terminals inherit; agents find the
// command itself in $HANDIDE_PEER.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * A one-word "handide-peer" command for the editor's terminals, on their PATH. A command
 * line in a variable ("node" "…/server.mjs" peer) does not run as $HANDIDE_PEER: shells
 * keep the quotes from a variable as part of the name.
 */
export async function peerLauncherEnv(dataDir, serverPath) {
	const bin = join(dataDir, 'bin');
	await mkdir(bin, { recursive: true });
	if (process.platform === 'win32') {
		await writeFile(join(bin, 'handide-peer.cmd'), `@"${process.execPath}" "${serverPath}" peer %*\r\n`);
	} else {
		const file = join(bin, 'handide-peer');
		await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${serverPath}" peer "$@"\n`);
		await chmod(file, 0o755);
	}
	const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
	return { [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`, HANDIDE_PEER: 'handide-peer' };
}

const HELP = `handide peer                       the other PCs and the project each serves
handide peer <pc> ls [path]        a folder ("/" by default): type, size, name
handide peer <pc> cat <path>       a file's contents, as they are on that PC
handide peer <pc> stat <path>      type, size and modification time
handide peer <pc> grep <text>      lines containing <text> (case-insensitive), searched on that PC

Paths are relative to the project that PC serves, "/"-separated. Read-only: change
files on the PC that owns them.`;

async function request(pc, endpoint, query = {}) {
	const base = process.env.HANDIDE_BRIDGE_URL;
	const secret = process.env.HANDIDE_BRIDGE_SECRET;
	if (!base || !secret) throw new Error('run this in a terminal of the handide editor (HANDIDE_BRIDGE_URL is not set)');
	const path = pc ? `/peer/${encodeURIComponent(pc)}/${endpoint}` : '/peer/';
	const res = await fetch(`${base}${path}?${new URLSearchParams(query)}`, { headers: { 'x-handide-secret': secret } });
	if (res.status === 404) throw new Error(pc ? `not found (or no PC named "${pc}"; "handide peer" lists them)` : 'not found');
	if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
	return res;
}

const clean = (p) => String(p ?? '').replace(/^\/+/, '');

export async function peerCommand(args) {
	const [pc, action, ...rest] = args;
	try {
		if (!pc) {
			for (const p of await (await request(null)).json()) console.log(`${p.name}\t${p.project ?? '(offline, not seen yet)'}`);
			return;
		}
		if (pc === 'help' || pc === '--help') return console.log(HELP);
		if (action === 'ls') {
			const { entries } = await (await request(pc, 'list', { path: clean(rest[0]) })).json();
			for (const [name, type, size] of entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
				console.log(`${type === 2 ? 'dir ' : 'file'}\t${type === 2 ? '' : size}\t${name}${type === 2 ? '/' : ''}`);
			}
		} else if (action === 'cat') {
			if (!rest[0]) throw new Error('a path is needed');
			process.stdout.write(Buffer.from(await (await request(pc, 'file', { path: clean(rest[0]) })).arrayBuffer()));
		} else if (action === 'stat') {
			const [type, size, mtime] = await (await request(pc, 'stat', { path: clean(rest[0]) })).json();
			console.log(`${type === 2 ? 'dir' : 'file'}\t${size}\t${new Date(mtime).toISOString()}`);
		} else if (action === 'grep') {
			const q = rest.join(' ');
			if (!q) throw new Error('text to search for is needed');
			const { matches, partial } = await (await request(pc, 'search', { q })).json();
			for (const [path, line, text] of matches) console.log(`${path}:${line}: ${text}`);
			if (partial) console.error('handide peer: stopped early (time or result limit); narrow it with "ls" and a smaller folder');
		} else {
			console.log(HELP);
			process.exitCode = 2;
		}
	} catch (err) {
		console.error(`handide peer: ${err.message}`);
		process.exitCode = 1;
	}
}
