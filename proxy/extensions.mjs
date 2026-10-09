// Brings the extensions installed in the user's desktop editors (VS Code, Cursor) into
// handide's VS Code, so agents like Claude Code or Codex show up on the phone too.
// serve-web keeps its own extensions dir and has no option to point elsewhere, so each
// extension folder is *linked* there (a junction on Windows: no copy, no admin rights)
// and listed in the server's registry. Folders and registry entries handide's own VS Code
// installed are never touched. One the user uninstalls on the phone stays uninstalled:
// it is remembered in IMPORT_STATE and not linked again on later runs.
import { lstat, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const SOURCES = [
	{ name: 'VS Code', dir: process.env.VSCODE_EXTENSIONS || join(os.homedir(), '.vscode', 'extensions') },
	{ name: 'Cursor', dir: join(os.homedir(), '.cursor', 'extensions') },
];
// Editor-specific builds that only work inside their own editor.
const SKIP_PUBLISHERS = new Set(['anysphere']);

const cmpVersion = (a, b) => {
	const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
	const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
};
const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);
// { imported: [ids linked last run], removed: [ids the user uninstalled] }
const IMPORT_STATE = '.handide-imports.json';

/** Newest copy of every desktop extension, across editors: id → { entry, folder, source }. */
async function desktopExtensions(skipIds) {
	const found = new Map();
	for (const src of SOURCES) {
		const registry = await readJson(join(src.dir, 'extensions.json'));
		if (!Array.isArray(registry)) continue;
		for (const entry of registry) {
			const id = entry.identifier?.id?.toLowerCase();
			if (!id || skipIds.has(id) || SKIP_PUBLISHERS.has(id.split('.')[0])) continue;
			const name = entry.relativeLocation || entry.location?.fsPath?.split(/[\\/]/).pop();
			const folder = name && join(src.dir, name);
			if (!folder || !existsSync(join(folder, 'package.json'))) continue;
			const prev = found.get(id);
			if (!prev || cmpVersion(entry.version, prev.entry.version) > 0) found.set(id, { entry, name, folder, source: src.name });
		}
	}
	return found;
}

const isLink = (p) => lstat(p).then((s) => s.isSymbolicLink(), () => false);

/**
 * Links the desktop extensions into extDir and registers them. Returns the imported
 * ids by source, for the log.
 */
export async function importDesktopExtensions(extDir, { skipIds = [] } = {}) {
	const registryPath = join(extDir, 'extensions.json');
	const registry = (await readJson(registryPath)) || [];
	const statePath = join(extDir, IMPORT_STATE);
	const state = (await readJson(statePath)) || {};
	const removed = new Set(state.removed || []);
	// Uninstalling in VS Code drops the registry entry and marks the folder in .obsolete
	// (VS Code deletes it on its next start). Either sign means the user removed it.
	const obsoletePath = join(extDir, '.obsolete');
	const obsolete = (await readJson(obsoletePath)) || {};
	const listed = new Set(registry.map((e) => e.identifier?.id?.toLowerCase()));
	for (const id of state.imported || []) if (!listed.has(id)) removed.add(id);
	let obsoleteChanged = false;
	for (const name of Object.keys(obsolete)) {
		const p = join(extDir, name);
		if (!(await isLink(p))) continue; // handide's own folders are VS Code's to clean up
		const id = name.match(/^(.+?)-\d+\.\d+/)?.[1]?.toLowerCase();
		if (id) removed.add(id);
		// Unlinked here, so VS Code's cleanup never reaches into the desktop editor's folder.
		await unlink(p).catch(() => {});
		delete obsolete[name];
		obsoleteChanged = true;
	}
	if (obsoleteChanged) await writeFile(obsoletePath, JSON.stringify(obsolete));

	const own = new Set(registry.filter((e) => !e.metadata?.handideImported).map((e) => e.identifier?.id?.toLowerCase()));
	const wanted = await desktopExtensions(new Set([...skipIds.map((s) => s.toLowerCase()), ...own, ...removed]));

	// Drop links from earlier runs that are no longer wanted (uninstalled here or on the desktop, or updated).
	const keep = [];
	for (const e of registry) {
		const id = e.identifier?.id?.toLowerCase();
		if (!e.metadata?.handideImported) keep.push(e);
		else if (wanted.get(id)?.name !== e.relativeLocation) {
			const p = join(extDir, e.relativeLocation);
			if (await isLink(p)) await unlink(p).catch(() => {});
		}
	}

	const imported = {};
	for (const [id, { entry, name, folder, source }] of wanted) {
		const dest = join(extDir, name);
		if (!existsSync(dest)) await symlink(folder, dest, process.platform === 'win32' ? 'junction' : 'dir');
		else if (!(await isLink(dest))) continue; // a real folder of the same name: handide's own copy
		const url = pathToFileURL(dest);
		keep.push({
			...entry,
			location: { $mid: 1, fsPath: dest, path: url.pathname, scheme: 'file' },
			relativeLocation: name,
			// Pinned: VS Code would otherwise "update" it into extDir and retire the linked folder,
			// which belongs to the desktop editor. Updating stays the desktop editor's job.
			metadata: { ...entry.metadata, pinned: true, handideImported: source },
		});
		(imported[source] ??= []).push(id);
	}
	await writeFile(registryPath, JSON.stringify(keep));
	await writeFile(statePath, JSON.stringify({ imported: [...wanted.keys()], removed: [...removed].sort() }));
	return imported;
}

/** Removes every link importDesktopExtensions made (importExtensions: false). */
export async function removeImportedExtensions(extDir) {
	const registryPath = join(extDir, 'extensions.json');
	const registry = await readJson(registryPath);
	if (!Array.isArray(registry)) return;
	const keep = [];
	for (const e of registry) {
		if (!e.metadata?.handideImported) keep.push(e);
		else if (await isLink(join(extDir, e.relativeLocation))) await unlink(join(extDir, e.relativeLocation)).catch(() => {});
	}
	if (keep.length !== registry.length) await writeFile(registryPath, JSON.stringify(keep));
}
