// Packages the desktop extension with handide inside, for the Marketplace and Open VSX:
// desktop/out/handide-<version>.vsix
//
//   node desktop/build.mjs      (npm run vsix)
//
// app/ is what handide runs from, as in the Windows installer (installer/build.mjs), with
// its runtime dependencies; the extension sets up Node.js for it (desktop/runtime.js).
// "handide desktop" installs the extension without app/, pointed at the handide it runs.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handideVersion } from '../scripts/version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'out');
const STAGE = join(OUT, 'stage');
const APP_ENTRIES = ['proxy', 'layer', 'extension', 'profile', 'layer.config.json', 'package.json', 'package-lock.json', 'LICENSE'];

const log = (msg) => console.log(`[vsix] ${msg}`);

function run(cmd, args, cwd) {
	// npm and npx are .cmd on Windows, which only run through a shell; these arguments need no quoting.
	const r = spawnSync([cmd, ...args].join(' '), { cwd, stdio: 'inherit', shell: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k))) });
	if (r.status !== 0) {
		console.error(`[vsix] ${cmd} ${args.join(' ')} failed (${r.status ?? r.error?.message})`);
		process.exit(1);
	}
}

// One version for the command, the companion and this extension (scripts/version.mjs).
handideVersion();
const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
rmSync(STAGE, { recursive: true, force: true, maxRetries: 5 }); // retries: antivirus scans hold files briefly
mkdirSync(STAGE, { recursive: true });
for (const name of ['package.json', 'README.md', ...manifest.files.filter((f) => !f.includes('*'))]) cpSync(join(HERE, name), join(STAGE, name));

const app = join(STAGE, 'app');
for (const entry of APP_ENTRIES) if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(app, entry), { recursive: true });
log('installing handide runtime dependencies...');
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], app);

const file = join(OUT, `${manifest.name}-${manifest.version}.vsix`);
run('npx', ['--yes', '@vscode/vsce@latest', 'package', '--no-dependencies', '-o', `"${file}"`], STAGE);
log(`done: ${file}`);
