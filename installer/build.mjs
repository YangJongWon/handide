// Builds the Windows installer: installer/out/handide-setup-<version>.exe
//
//   node installer/build.mjs               stage + compile (needs Inno Setup 6)
//   node installer/build.mjs --stage-only  stage only (installer/out/stage)
//
// The installer carries its own Node.js (latest LTS, checksum-verified), so the PC
// needs nothing beforehand; VS Code and Tailscale are fetched by the installer itself.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIcon } from './icon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'out');
const STAGE = join(OUT, 'stage');
const CACHE = join(OUT, 'cache');
const APP_ENTRIES = ['proxy', 'layer', 'extension', 'profile', 'layer.config.json', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README.ko.md', 'README.ja.md'];

const log = (msg) => console.log(`[build] ${msg}`);
const fail = (msg) => {
	console.error(`[build] ${msg}`);
	process.exit(1);
};

function run(cmd, args, opts = {}) {
	// npm is a .cmd on Windows, which only runs through a shell; our arguments need no quoting.
	const r = cmd.endsWith('.exe')
		? spawnSync(cmd, args, { stdio: 'inherit', ...opts })
		: spawnSync([cmd, ...args].join(' '), { stdio: 'inherit', shell: true, ...opts });
	if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error?.message})`);
}

async function download(url) {
	const resp = await fetch(url);
	if (!resp.ok) fail(`download failed: ${url} (HTTP ${resp.status})`);
	return Buffer.from(await resp.arrayBuffer());
}

/** Latest LTS node.exe for win-x64, cached and checked against the release's SHASUMS256. */
async function fetchNode() {
	const releases = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString());
	const { version } = releases.find((r) => r.lts && r.files.includes('win-x64-exe'));
	const cached = join(CACHE, `node-${version}-win-x64.exe`);
	const base = `https://nodejs.org/dist/${version}`;
	const sums = (await download(`${base}/SHASUMS256.txt`)).toString();
	const expected = sums.match(/^([0-9a-f]{64})\s+win-x64\/node\.exe$/m)?.[1];
	if (!expected) fail(`no checksum for win-x64/node.exe in ${base}/SHASUMS256.txt`);
	const sha = (buf) => createHash('sha256').update(buf).digest('hex');
	if (!existsSync(cached) || sha(readFileSync(cached)) !== expected) {
		log(`downloading Node.js ${version}...`);
		const exe = await download(`${base}/win-x64/node.exe`);
		if (sha(exe) !== expected) fail('node.exe checksum mismatch');
		mkdirSync(CACHE, { recursive: true });
		writeFileSync(cached, exe);
	}
	return { version, file: cached };
}

/** Windows PowerShell 5.1 reads BOM-less scripts as ANSI, which breaks the Korean text. */
function copyWindowsScript(src, dest, { bom = false } = {}) {
	const text = readFileSync(src, 'utf8').replace(/^﻿/, '').replace(/\r?\n/g, '\r\n');
	writeFileSync(dest, `${bom ? '﻿' : ''}${text}`);
}

function findIscc() {
	const candidates = [
		process.env.ISCC,
		process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
		process.env.ProgramFiles && join(process.env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
	];
	const found = candidates.find((p) => p && existsSync(p));
	if (found) return found;
	return spawnSync('where', ['iscc'], { encoding: 'utf8' }).stdout?.split(/\r?\n/)[0] || null;
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
log(`handide ${version}`);

rmSync(STAGE, { recursive: true, force: true, maxRetries: 5 }); // retries: antivirus scans hold files briefly
const app = join(STAGE, 'app');
mkdirSync(app, { recursive: true });
for (const entry of APP_ENTRIES) {
	if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(app, entry), { recursive: true });
}
log('installing runtime dependencies...');
// Under "npm run installer" the outer npm's settings arrive as npm_config_* and confuse this one.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, env });

const node = await fetchNode();
mkdirSync(join(STAGE, 'node'), { recursive: true });
cpSync(node.file, join(STAGE, 'node', 'node.exe'));
log(`bundled Node.js ${node.version}`);

copyWindowsScript(join(HERE, 'launch.ps1'), join(STAGE, 'launch.ps1'), { bom: true });
copyWindowsScript(join(HERE, 'handide.cmd'), join(STAGE, 'handide.cmd'));
writeIcon(join(STAGE, 'handide.ico'));
log(`staged in ${STAGE}`);

if (process.argv.includes('--stage-only')) process.exit(0);

const iscc = findIscc();
if (!iscc) fail('Inno Setup 6 not found. Install it (winget install JRSoftware.InnoSetup) or set ISCC to ISCC.exe.');
run(iscc, [`/DAppVersion=${version}`, `/DStageDir=${STAGE}`, `/O${OUT}`, join(HERE, 'handide.iss')]);
log(`done: ${join(OUT, `handide-setup-${version}.exe`)}`);
