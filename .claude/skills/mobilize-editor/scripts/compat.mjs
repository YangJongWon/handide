#!/usr/bin/env node
// Install-time compatibility check. Static and fast: it does not start the editor.
//
//   npm run compat                    # auto-detect the editor
//   npm run compat -- --editor <cli>
//   npm run compat -- --pretend-version 1.99.0   # test the uncertain/incompatible paths
//
// Prints a JSON verdict for the skill to act on, then exits
//   0 = compatible, 2 = uncertain (run `npm run check` to confirm), 3 = incompatible.
//
// Verdicts cover:
//  - editor:    an installed editor that can serve its web UI (serve-web)
//  - companion: the handide extension vs that editor (engines.vscode, tested version)
//  - layer:     layer/selectors.json testedWith vs the editor version
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import { ROOT } from './lib/proxy.mjs';

const { detectEditorCli, editorVersion } = await import(new URL(`file:///${join(ROOT, 'proxy/editor.mjs').replace(/\\/g, '/')}`).href);

const argv = process.argv.slice(2);
const explicit = argv.includes('--editor') ? argv[argv.indexOf('--editor') + 1] : undefined;
const pretend = argv.includes('--pretend-version') ? argv[argv.indexOf('--pretend-version') + 1] : undefined;

const parse = (v) => (/(\d+)\.(\d+)\.(\d+)/.exec(v || '') || []).slice(1, 4).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Cursor and other forks that ship without serve-web. */
function findForksWithoutServeWeb() {
	const found = [];
	const local = process.env.LOCALAPPDATA || '';
	const candidates = {
		Cursor: [join(local, 'Programs/cursor/resources/app/bin/cursor.cmd'), '/Applications/Cursor.app', join(os.homedir(), '.local/bin/cursor')],
		Windsurf: [join(local, 'Programs/Windsurf/bin/windsurf.cmd'), '/Applications/Windsurf.app'],
	};
	for (const [name, paths] of Object.entries(candidates)) {
		if (paths.some((p) => existsSync(p))) found.push(name);
	}
	const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' });
	if (/cursor/i.test(which.stdout) && !found.includes('Cursor')) found.push('Cursor');
	return found;
}

const result = { editor: {}, companion: {}, layer: {}, verdict: 'compatible', choices: [] };

// ---------------------------------------------------------------- editor
let cli;
try {
	cli = detectEditorCli(explicit);
	const version = editorVersion(cli);
	result.editor = { cli, version: parse(version).join('.'), raw: version };
} catch (err) {
	result.editor = { cli: null, error: err.message };
}
const forks = findForksWithoutServeWeb();
if (forks.length) {
	result.editor.forksWithoutServeWeb = forks;
	result.editor.note = `${forks.join(', ')} installed but cannot serve a web UI; handide uses VS Code. ${forks.includes('Cursor') ? 'The `code` command on PATH may point to Cursor.' : ''}`.trim();
}

if (!cli) {
	result.verdict = 'incompatible';
	result.companion = { status: 'n/a' };
	result.layer = { status: 'n/a' };
	result.reasons = ['No editor with serve-web found. Install VS Code (it can sit next to Cursor), or pass --editor <path to code CLI>.'];
	result.choices = [{ id: 'install-vscode', label: 'VS Code 설치 후 다시 점검', description: 'Cursor 등은 웹 출력 기능이 없어 handide의 기반으로 쓸 수 없습니다.' }];
	console.log(JSON.stringify(result, null, 2));
	process.exit(3);
}

if (pretend) result.editor = { ...result.editor, version: pretend, pretend: true };
const editorV = parse(result.editor.version);

// ---------------------------------------------------------------- companion
const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/package.json'), 'utf8'));
const engine = manifest.engines?.vscode ?? '*';
const minV = parse(engine);
const selectors = JSON.parse(readFileSync(join(ROOT, 'layer/selectors.json'), 'utf8'));
const testedV = parse(selectors.testedWith?.version);
const internalCommands = ['vscode.moveViews', 'workbench.action.toggleMaximizedPanel', 'workbench.action.maximizeAuxiliaryBar', 'workbench.action.maximizeEditorHideSidebar'];

const reasons = [];
if (minV.length && cmp(editorV, minV) < 0) {
	result.companion = { status: 'incompatible', engine, reason: `editor ${result.editor.version} is older than the extension's engines.vscode ${engine}` };
	reasons.push(result.companion.reason);
} else if (testedV.length && cmp(editorV, testedV) !== 0) {
	result.companion = {
		status: 'uncertain',
		engine,
		reason: `engine ok, but tab switching relies on layout commands only verified on ${testedV.join('.')}`,
		verifyCommands: internalCommands,
	};
	reasons.push(result.companion.reason);
} else {
	result.companion = { status: 'compatible', engine };
}

// ---------------------------------------------------------------- layer
if (!testedV.length || cmp(editorV, testedV) === 0) result.layer = { status: 'tested', testedWith: selectors.testedWith };
else {
	result.layer = {
		status: cmp(editorV, testedV) > 0 ? 'untested-newer' : 'untested-older',
		testedWith: selectors.testedWith,
		reason: `layer DOM hooks verified on ${testedV.join('.')}, editor is ${result.editor.version}`,
	};
	reasons.push(result.layer.reason);
}

// ---------------------------------------------------------------- verdict + choices
const statuses = [result.companion.status, result.layer.status];
result.verdict = statuses.includes('incompatible') ? 'incompatible' : statuses.some((s) => s === 'uncertain' || s.startsWith('untested')) ? 'uncertain' : 'compatible';
result.reasons = reasons;
if (result.verdict !== 'compatible') {
	result.choices = [
		{ id: 'extension', label: '확장 그대로 설치 (경고)', description: '탭마다 한 영역을 전체 화면으로. 명령이 바뀌었으면 탭이 동작하지 않을 수 있어, 설치 후 npm run check로 확인합니다.' },
		{ id: 'builtin', label: '확장 없이 기본 단축키 모드', description: 'VS Code 기본 단축키만 사용. 어느 버전에서나 동작하지만 영역이 전체 화면으로 커지지 않습니다.' },
		{ id: 'skip', label: '설치 중단', description: '아무것도 바꾸지 않고, 호환 문제를 먼저 해결합니다.' },
	];
	if (result.companion.status === 'incompatible') result.choices.shift(); // extension cannot load at all
}

console.log(JSON.stringify(result, null, 2));
process.exit({ compatible: 0, uncertain: 2, incompatible: 3 }[result.verdict]);
