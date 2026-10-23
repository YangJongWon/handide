// Switching where a project runs, quickly and without losing work: on the PC it lives on
// (the desktop editor opens it there through Remote - SSH), or here, in a working copy.
// With git (the default), a switch carries everything as it is, uncommitted and new files
// included:
//
//   from ──snapshot──> a commit of the working tree (refs/handide/wip, parent HEAD), made
//                      with a separate index, so the real index and branch are untouched
//        ──bundle────> only the objects the other side lacks, over SSH
//   to   ──apply─────> same branch at the same HEAD, working tree = the snapshot
//
// The side being left remembers the tree it had; when work moves back to it and its tree
// is no longer that (it was edited meanwhile), those edits are stashed, never dropped.
//
// "handide switch-agent <op> <folder>" runs the steps on a PC; the PC whose editor switches
// runs "handide switch here|back" and drives the other one over SSH (proxy/ssh.mjs).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import os from 'node:os';
import { loadDevices } from './devices.mjs';

const WIP_REF = 'refs/handide/wip';
const INCOMING_REF = 'refs/handide/incoming';
const STATE_FILE = 'handide-switch.json'; // in the git dir: never committed
// commit-tree needs an identity; a repo without one configured still switches.
const IDENTITY = ['-c', 'user.name=handide', '-c', 'user.email=handide@localhost'];

function run(cmd, args, { cwd, env, input, binary } = {}) {
	return new Promise((ok, fail) => {
		const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
		const out = [];
		const err = [];
		child.stdout.on('data', (d) => out.push(d));
		child.stderr.on('data', (d) => err.push(d));
		child.on('error', fail);
		child.on('close', (code) => {
			const stdout = Buffer.concat(out);
			if (code !== 0) return fail(new Error(`${cmd} ${args.filter((a) => !a.startsWith('-c')).slice(0, 3).join(' ')}: ${Buffer.concat(err).toString().trim() || `exit ${code}`}`));
			ok(binary ? stdout : stdout.toString('utf8').trim());
		});
		if (input) child.stdin.end(input);
		else child.stdin.end();
	});
}

const git = (folder, args, opts = {}) => run('git', ['-C', folder, ...args], opts);
const gitOk = (folder, args, opts) => git(folder, args, opts).then(() => true, () => false);

async function gitDir(folder) {
	return git(folder, ['rev-parse', '--absolute-git-dir']).catch(() => {
		throw new Error(`${folder} is not a git repository (switching with git needs one)`);
	});
}

async function readState(folder) {
	return readFile(join(await gitDir(folder), STATE_FILE), 'utf8').then(JSON.parse, () => ({}));
}
async function writeState(folder, state) {
	await writeFile(join(await gitDir(folder), STATE_FILE), JSON.stringify(state, null, '\t') + '\n');
}

/** The working tree as a git tree (non-ignored files, as they are), via a copy of the index. */
async function worktreeTree(folder) {
	const dir = await gitDir(folder);
	const index = join(dir, 'handide-index');
	if (existsSync(join(dir, 'index'))) await copyFile(join(dir, 'index'), index);
	else await rm(index, { force: true });
	const env = { GIT_INDEX_FILE: index };
	await git(folder, ['add', '-A'], { env });
	const tree = await git(folder, ['write-tree'], { env });
	await rm(index, { force: true });
	return tree;
}

/** Commits the working tree (not on any branch): what the other side should end up with. */
export async function snapshot(folder) {
	const head = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => {
		throw new Error(`${folder} has no commit yet: commit once, then switch`);
	});
	const branch = await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => null);
	const tree = await worktreeTree(folder);
	const wip = await git(folder, [...IDENTITY, 'commit-tree', tree, '-p', head, '-m', `handide: working tree on ${os.hostname()}`]);
	await git(folder, ['update-ref', WIP_REF, wip]);
	const remotes = await git(folder, ['remote', '-v']).catch(() => '');
	return { branch, head, wip, tree, remotes: parseRemotes(remotes) };
}

function parseRemotes(text) {
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
		if (m) out[m[1]] = m[2];
	}
	return out;
}

/** Commits this side has, for the other side to leave out of its bundle. */
export async function heads(folder) {
	if (!existsSync(folder) || !(await gitOk(folder, ['rev-parse', '--git-dir']))) return [];
	const refs = await git(folder, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags', WIP_REF]).catch(() => '');
	const head = await git(folder, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => '');
	return [...new Set([...refs.split(/\s+/), head].filter(Boolean))];
}

/** A bundle of `ref` without what the other side has (those of `known` this side also has). */
export async function bundle(folder, ref, known = [], { all = false } = {}) {
	const have = [];
	for (const sha of known) if (/^[0-9a-f]{40,64}$/.test(sha) && (await gitOk(folder, ['cat-file', '-e', `${sha}^{commit}`]))) have.push(sha);
	const not = have.length ? ['--not', ...have] : [];
	// Nothing the other side lacks (e.g. a switch right back, same snapshot): nothing to send.
	if (!all && (await git(folder, ['rev-list', '--count', ref, ...not])) === '0') return Buffer.alloc(0);
	const file = join(await gitDir(folder), 'handide-out.bundle');
	await git(folder, ['bundle', 'create', '-q', file, ...(all ? ['--all'] : [ref]), ...not]);
	const data = await readFile(file);
	await rm(file, { force: true });
	return data;
}

/** Takes a bundle in: its ref `ref` lands at refs/handide/incoming. */
export async function receive(folder, data, ref = WIP_REF) {
	if (!data.length) return null; // it had everything already
	const file = join(await gitDir(folder), 'handide-in.bundle');
	await writeFile(file, data);
	try {
		await git(folder, ['fetch', '-q', file, `+${ref}:${INCOMING_REF}`]);
	} finally {
		await rm(file, { force: true });
	}
	return git(folder, ['rev-parse', INCOMING_REF]);
}

/**
 * Makes this side what the other side had: `branch` at `head`, working tree = `wip`. Nothing
 * of this side is dropped: edits made here since work last moved away are stashed, and
 * commits made here that `head` lacks keep a branch handide-backup/<branch>-<time>.
 * Resolves to { stashed, backup }.
 */
export async function apply(folder, { branch, head, wip }, from, { fresh = false } = {}) {
	const state = await readState(folder);
	let stashed = false;
	if (!fresh) {
		const now = await worktreeTree(folder);
		const headTree = await git(folder, ['rev-parse', 'HEAD^{tree}']).catch(() => null);
		// Untouched since we left (or clean): safe to replace. Otherwise keep those edits aside.
		if (now !== (state.leftTree ?? headTree)) {
			await git(folder, [...IDENTITY, 'stash', 'push', '-u', '-q', '-m', `handide: edits made here while the project ran on ${from}`]);
			stashed = true;
		}
	}
	let backup = null;
	const tip = branch ? await git(folder, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).catch(() => null) : null;
	if (tip && tip !== head && !(await gitOk(folder, ['merge-base', '--is-ancestor', tip, head]))) {
		backup = `handide-backup/${branch}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
		await git(folder, ['branch', '-f', backup, tip]);
	}
	await git(folder, ['reset', '-q', '--hard']).catch(() => {}); // a fresh clone has nothing to reset
	await git(folder, ['clean', '-q', '-fd']);
	await git(folder, branch ? ['checkout', '-q', '-f', '-B', branch, head] : ['checkout', '-q', '-f', '--detach', head]);
	await git(folder, ['restore', `--source=${wip}`, '--worktree', '--', ':/']);
	await writeState(folder, { ...state, leftTree: null, activeSince: Date.now() });
	return { stashed, backup };
}

/** Work moved away from this side: remember its tree, to notice edits made here meanwhile. */
export async function left(folder, tree) {
	await writeState(folder, { ...(await readState(folder)), leftTree: tree, activeSince: null });
}

// ---------------------------------------------------------------- agent (the other PC)

/** "handide switch-agent <op> <folder> [...]": one step on this PC; JSON or a bundle on stdout. */
export async function switchAgent([op, folder, ...rest]) {
	const readStdin = async () => {
		const chunks = [];
		for await (const c of process.stdin) chunks.push(c);
		return Buffer.concat(chunks);
	};
	const json = (v) => process.stdout.write(JSON.stringify(v));
	try {
		if (op === 'snapshot') return json(await snapshot(folder));
		if (op === 'heads') return json(await heads(folder));
		if (op === 'bundle') return process.stdout.write(await bundle(folder, rest[0] === '--all' ? null : rest[0], rest.slice(1), { all: rest[0] === '--all' }));
		if (op === 'receive') return json({ incoming: await receive(folder, await readStdin()) });
		if (op === 'apply') return json(await apply(folder, JSON.parse(rest[0]), rest[1]));
		if (op === 'left') return json((await left(folder, rest[0]), { ok: true }));
		throw new Error(`unknown switch-agent op "${op}"`);
	} catch (err) {
		process.stderr.write(`${err.message}\n`);
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------- driver (this PC)

const copiesFile = (dataDir) => join(dataDir, 'copies.json');
const loadCopies = (dataDir) => readFile(copiesFile(dataDir), 'utf8').then(JSON.parse, () => []);
const saveCopies = (dataDir, list) => writeFile(copiesFile(dataDir), JSON.stringify(list, null, '\t') + '\n');
const samePath = (a, b) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();

/** Runs a switch-agent step on another PC over SSH. */
function agent(device, args, { input, binary } = {}) {
	const cli = device.ssh?.cli;
	if (!cli) throw new Error(`${device.name} runs an older handide: update it there and start it again`);
	const q = (s) => `"${String(s).replaceAll('"', '\\"')}"`;
	const command = [q(cli.node), q(cli.server), 'switch-agent', ...args.map(q)].join(' ');
	return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `handide-${device.name}`, command], { input, binary });
}

async function deviceNamed(dataDir, name) {
	const d = (await loadDevices(dataDir)).find((x) => x.name === name);
	if (!d) throw new Error(`no PC named "${name}" ("handide devices" lists them)`);
	return d;
}

/**
 * "handide switch here <pc> <folder on it> [--to <folder here>]": the project of that PC runs
 * here from now on, in a working copy (made on the first switch, ~/handide-copies/<pc>/<name>).
 */
async function switchHere(dataDir, [pcName, remoteFolder, ...rest]) {
	const device = await deviceNamed(dataDir, pcName);
	const copies = await loadCopies(dataDir);
	let copy = copies.find((c) => c.pc === device.name && samePath(c.remote, remoteFolder));
	const to = rest[0] === '--to' ? rest[1] : null;
	const local = to || copy?.local || join(os.homedir(), 'handide-copies', device.name, basename(remoteFolder.replaceAll('\\', '/')));

	const snap = JSON.parse(await agent(device, ['snapshot', remoteFolder]));
	const fresh = !existsSync(join(local, '.git'));
	const data = await agent(device, ['bundle', remoteFolder, fresh ? '--all' : WIP_REF, ...(fresh ? [] : await heads(local))], { binary: true });
	if (fresh) {
		await mkdir(join(local, '..'), { recursive: true });
		const file = join(os.tmpdir(), `handide-${process.pid}.bundle`);
		await writeFile(file, data);
		try {
			await run('git', ['clone', '-q', '--no-checkout', file, local]);
			// A clone takes branches and tags only; the snapshot is outside them.
			await git(local, ['fetch', '-q', file, `+${WIP_REF}:${INCOMING_REF}`]);
		} finally {
			await rm(file, { force: true });
		}
		// The project's own remotes (e.g. GitHub), so pushing works from here too.
		await git(local, ['remote', 'remove', 'origin']).catch(() => {});
		for (const [name, url] of Object.entries(snap.remotes)) await git(local, ['remote', 'add', name, url]).catch(() => {});
	} else {
		await receive(local, data);
	}
	const result = await apply(local, { branch: snap.branch, head: snap.head, wip: snap.wip }, device.name, { fresh });
	await agent(device, ['left', remoteFolder, snap.tree]);
	if (!copy) copies.push((copy = { pc: device.name, remote: remoteFolder, local, sync: 'git' }));
	copy.local = local;
	copy.active = 'here';
	await saveCopies(dataDir, copies);
	return { local, pc: device.name, remote: remoteFolder, branch: snap.branch, ...result };
}

/** "handide switch back <folder here>": the working copy's project runs on its PC again. */
async function switchBack(dataDir, [localFolder]) {
	const copies = await loadCopies(dataDir);
	const copy = copies.find((c) => samePath(c.local, localFolder));
	if (!copy) throw new Error(`${localFolder} is not a working copy handide made`);
	const device = await deviceNamed(dataDir, copy.pc);
	const snap = await snapshot(localFolder);
	const known = JSON.parse(await agent(device, ['heads', copy.remote]));
	await agent(device, ['receive', copy.remote], { input: await bundle(localFolder, WIP_REF, known) });
	const result = JSON.parse(await agent(device, ['apply', copy.remote, JSON.stringify({ branch: snap.branch, head: snap.head, wip: snap.wip }), os.hostname()]));
	await left(localFolder, snap.tree);
	copy.active = 'there';
	await saveCopies(dataDir, copies);
	return { pc: device.name, host: `handide-${device.name}`, platform: device.ssh?.platform, remote: copy.remote, branch: snap.branch, ...result };
}

/** "handide switch here|back|list ...": prints one JSON line (the desktop extension reads it). */
export async function switchCommand([how, ...args], { dataDir }) {
	try {
		const result =
			how === 'here' ? await switchHere(dataDir, args)
			: how === 'back' ? await switchBack(dataDir, args)
			: how === 'list' ? await loadCopies(dataDir)
			: null;
		if (!result) throw new Error('usage: handide switch here <pc> <folder on it> [--to <folder here>] | back <folder here> | list');
		console.log(JSON.stringify({ ok: true, ...(Array.isArray(result) ? { copies: result } : result) }));
	} catch (err) {
		console.log(JSON.stringify({ ok: false, error: err.message }));
		process.exitCode = 1;
	}
}
