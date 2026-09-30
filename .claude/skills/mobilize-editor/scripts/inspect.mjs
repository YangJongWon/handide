#!/usr/bin/env node
// DOM inspector for repairing layer/selectors.json after an editor update.
//
//   node .claude/skills/mobilize-editor/scripts/inspect.mjs
//   node .claude/skills/mobilize-editor/scripts/inspect.mjs --find "Source Control" --find "Trust"
//   node .claude/skills/mobilize-editor/scripts/inspect.mjs --tab terminal --eval "document.querySelector('.part.panel').className"
//
// Opens the handide page on a phone viewport (private proxy, trust granted) and prints:
//  - each selectors.json entry: found / missing (+ count)
//  - the workbench's part structure (tag, id, classes, size)
//  - for every --find text: the class path of the smallest elements containing it
//  - the result of every --eval expression
// Also saves check-output/inspect.png.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, ROOT, killTree, loadPlaywright, startProxy } from './lib/proxy.mjs';
import { grantTrust } from './lib/trust.mjs';

const args = { device: 'Pixel 7', mode: 'extension', finds: [], evals: [], tab: null, editor: undefined };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--device') args.device = argv[++i];
	else if (a === '--mode') args.mode = argv[++i];
	else if (a === '--find') args.finds.push(argv[++i]);
	else if (a === '--eval') args.evals.push(argv[++i]);
	else if (a === '--tab') args.tab = argv[++i];
	else if (a === '--editor') args.editor = argv[++i];
}

const flatten = (obj, prefix = '') =>
	Object.entries(obj).flatMap(([k, v]) => {
		if (k.startsWith('$') || k === 'testedWith') return [];
		if (v && typeof v === 'object') return flatten(v, `${prefix}${k}.`);
		return typeof v === 'string' && /[.#[]/.test(v) ? [[`${prefix}${k}`, v]] : [];
	});

const { chromium, devices } = await loadPlaywright();
const proxy = await startProxy({ mode: args.mode, editor: args.editor });
const browser = await chromium.launch();
try {
	const { defaultBrowserType, ...device } = devices[args.device];
	const page = await (await browser.newContext(device)).newPage();
	await page.goto(proxy.url, { timeout: 120_000 });
	await page.waitForSelector('#hd-root', { timeout: 120_000 });
	console.log(`editor: ${proxy.editor}\ntrust: ${await grantTrust(page)}`);
	await page.waitForTimeout(5000);
	if (args.tab) {
		// --tab: a dock button (files, code, terminal, ai, git) or "search" (app bar).
		await page.tap(args.tab === 'search' ? '#hd-appbar [data-act="search"]' : `#hd-dock [data-dock="${args.tab}"]`);
		await page.waitForTimeout(1500);
	}

	const selectors = JSON.parse(readFileSync(join(ROOT, 'layer/selectors.json'), 'utf8'));
	console.log('\n# selectors.json  (dialog / modalEditor / quickInput / check.* exist only while shown: "missing" is normal unless that UI is open)');
	for (const [name, sel] of flatten(selectors)) {
		const n = await page.evaluate((s) => {
			try {
				return document.querySelectorAll(s).length;
			} catch {
				return -1;
			}
		}, sel);
		console.log(`${n > 0 ? 'found  ' : n < 0 ? 'invalid' : 'missing'} ${name.padEnd(22)} ${sel}${n > 1 ? `  (${n})` : ''}`);
	}

	console.log('\n# workbench parts');
	console.log(
		await page.evaluate(() => {
			const wb = document.querySelector('.monaco-workbench') || document.body;
			return [wb, ...wb.querySelectorAll('[class*="part"], [role="main"], [role="navigation"]')]
				.filter((el) => el === wb || el.classList.contains('part') || el.id.startsWith('workbench.parts'))
				.map((el) => {
					const r = el.getBoundingClientRect();
					return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}  ${Math.round(r.width)}x${Math.round(r.height)}`;
				})
				.join('\n');
		}),
	);

	for (const text of args.finds) {
		console.log(`\n# find "${text}"`);
		console.log(
			await page.evaluate((text) => {
				const hits = [...document.querySelectorAll('body *')].filter((el) => el.textContent?.includes(text) && ![...el.children].some((c) => c.textContent?.includes(text)));
				const path = (el) => {
					const parts = [];
					for (let e = el; e && e !== document.body && parts.length < 6; e = e.parentElement) {
						parts.unshift(`${e.tagName.toLowerCase()}${e.classList.length ? '.' + [...e.classList].slice(0, 3).join('.') : ''}`);
					}
					return parts.join(' > ');
				};
				return hits.slice(0, 8).map(path).join('\n') || '(not found)';
			}, text),
		);
	}

	for (const expr of args.evals) {
		const value = await page.evaluate((e) => {
			try {
				return JSON.stringify((0, eval)(e));
			} catch (err) {
				return `error: ${err.message}`;
			}
		}, expr);
		console.log(`\n# eval ${expr}\n${value}`);
	}
	await page.screenshot({ path: join(OUT, 'inspect.png') });
} finally {
	await browser.close();
	killTree(proxy.child);
}
