// One version for everything handide ships: the command (package.json), the companion
// extension the phone's VS Code runs (extension/) and the desktop extension (desktop/).
// The Windows installer and the desktop extension's .vsix are built from it, and a
// release tag v<version> must name it.
//
//   node scripts/version.mjs              # check that all three agree (the builds run this)
//   node scripts/version.mjs 0.6.0        # set all three
//   node scripts/version.mjs --tag v0.6.0 # also check a release tag (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFESTS = ['package.json', 'extension/package.json', 'desktop/package.json'];

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** The one version; throws when the manifests disagree. */
export function handideVersion() {
	const versions = MANIFESTS.map((rel) => [rel, JSON.parse(read(rel)).version]);
	const [[, main]] = versions;
	const off = versions.filter(([, v]) => v !== main);
	if (off.length) throw new Error(`versions differ: ${versions.map(([rel, v]) => `${rel} ${v}`).join(', ')}. Run "node scripts/version.mjs <version>".`);
	return main;
}

function setVersion(version) {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
	for (const rel of MANIFESTS) {
		const text = read(rel);
		// Only the top-level "version", keeping each file's own formatting.
		const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
		if (next === text && JSON.parse(text).version !== version) throw new Error(`no "version" in ${rel}`);
		writeFileSync(join(ROOT, rel), next);
	}
	return handideVersion();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		const tagAt = args.indexOf('--tag');
		const tag = tagAt >= 0 ? args.splice(tagAt, 2)[1] : null;
		const version = args[0] ? setVersion(args[0]) : handideVersion();
		if (tag && tag !== `v${version}`) throw new Error(`tag ${tag} does not match version ${version}`);
		console.log(version);
	} catch (err) {
		console.error(`[version] ${err.message}`);
		process.exit(1);
	}
}
