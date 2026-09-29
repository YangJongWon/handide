#!/usr/bin/env node
// Automated check of the handide mobile layer against the installed editor.
//
//   npm run check                          # start a private proxy, test Pixel 7 + iPhone 14
//   npm run check -- --devices "Pixel 7"   # one device
//   npm run check -- --mode builtin        # test the no-extension fallback
//   npm run check -- --editor <cli>        # a specific editor build
//   npm run check -- --url http://host:port/?tkn=...   # an already running handide
//   npm run check -- --android [serial]    # real Chrome on an emulator / USB phone (adb reverse)
//
// Uses its own data dir and sample workspace under check-output/, so your
// handide profile, layer.config.json and projects are never touched.
// Writes check-output/report.json and one screenshot per step; exits 1 on failure.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, ROOT, SAMPLE, killTree, loadPlaywright, startProxy } from './lib/proxy.mjs';
import { grantTrust } from './lib/trust.mjs';

const TYPED = '// 모바일 입력 확인';
const { chromium, devices: DEVICES, _android: android } = await loadPlaywright();

function parseArgs(argv) {
	const o = { devices: ['Pixel 7', 'iPhone 14'], mode: 'extension', editor: undefined, url: undefined, android: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--devices') o.devices = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
		else if (a === '--mode') o.mode = argv[++i];
		else if (a === '--editor') o.editor = argv[++i];
		else if (a === '--url') o.url = argv[++i];
		else if (a === '--android') o.android = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
	}
	return o;
}

// ------------------------------------------------------------------ checks

/**
 * @param {{ name: string, open: () => Promise<{ page, close: () => Promise<void> }> }} target
 */
async function checkDevice(target, ctx) {
	const deviceName = target.name;
	const results = [];
	const shotDir = join(OUT, deviceName.replace(/\W+/g, '-'));
	mkdirSync(shotDir, { recursive: true });
	const record = (name, ok, detail = '') => {
		results.push({ device: deviceName, name, ok, detail });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${deviceName.padEnd(10)} ${name.padEnd(22)} ${detail}`);
	};
	const step = async (name, fn) => {
		try {
			const r = await fn();
			record(name, r?.ok ?? true, r?.detail ?? '');
			return r?.ok ?? true;
		} catch (err) {
			record(name, false, err.message.split('\n')[0]);
			return false;
		} finally {
			await page.screenshot({ path: join(shotDir, `${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
		}
	};

	const { page, close } = await target.open();
	// Emulated devices tap through Playwright; real Android taps the screen via adb.
	const tapAt = target.tapAt;
	const tap = async (locatorOrSelector, position) => {
		const loc = typeof locatorOrSelector === 'string' ? page.locator(locatorOrSelector).first() : locatorOrSelector;
		if (!tapAt) return loc.tap(position ? { position } : undefined);
		await loc.waitFor({ timeout: 30_000 });
		const b = await loc.boundingBox();
		if (!b) throw new Error('element has no box');
		await tapAt(page, b.x + (position ? position.x : b.width / 2), b.y + (position ? position.y : b.height / 2));
	};
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => m.type() === 'error' && /handide/.test(m.text()) && errors.push(m.text()));
	const sel = JSON.parse(readFileSync(join(ROOT, 'layer/selectors.json'), 'utf8'));
	let vw = 0; // measured after load
	let apple = false;
	// Real visible height (the layer shims visualViewport.height / innerHeight).
	const viewportHeight = () =>
		page.evaluate(() => {
			const d = window.visualViewport && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(visualViewport), 'height');
			return d ? d.get.call(visualViewport) : document.documentElement.clientHeight;
		});

	const box = (s) =>
		page.evaluate((s) => {
			const el = document.querySelector(s);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			const shown = getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
			return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, shown };
		}, s);

	// Created before the page loads: on a first-run server the file watcher can take
	// longer than the check waits, and a file missing from the tree fails the edit step.
	const editName = `edit-${deviceName.replace(/W+/g, '-').toLowerCase()}.js`;
	const editFile = { name: editName, file: ctx.workspace ? join(ctx.workspace, editName) : null };
	if (editFile.file) writeFileSync(editFile.file, SAMPLE);

	await step('layer-injected', async () => {
		await page.goto(ctx.url, { timeout: 120_000 });
		await page.waitForSelector('#hd-root', { timeout: 120_000 });
		await page.waitForSelector(sel.workbench, { timeout: 120_000 });
		({ vw, apple } = await page.evaluate(() => ({ vw: innerWidth, apple: /iPhone|iPad|Macintosh/.test(navigator.userAgent) })));
		return { ok: true, detail: `viewport width ${vw}` };
	});

	await step('trust', async () => {
		const how = await grantTrust(page);
		await page.waitForTimeout(6000); // companion extension activation
		const restricted = await page.evaluate(() => !document.getElementById('hd-notice')?.hidden);
		return { ok: !restricted, detail: `granted via ${how}${restricted ? ', still restricted' : ''}` };
	});

	await step('selectors', async () => {
		const wanted = { workbench: sel.workbench, banner: sel.banner, ...sel.parts };
		const missing = await page.evaluate((w) => Object.entries(w).filter(([, s]) => !document.querySelector(s)).map(([k]) => k), wanted);
		return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `${Object.keys(wanted).length} found` };
	});

	// With the companion extension, Explorer/Search/SCM live in the (maximizable) panel;
	// in builtin mode they stay in VS Code's default side bar.
	const home = ctx.mode === 'builtin' ? 'sidebar' : 'panel';
	const expected = { code: 'editor', files: home, search: home, git: home, terminal: 'panel', chat: 'auxiliarybar' };
	const content = {
		files: () => page.locator(`${sel.parts[home]} ${sel.check.listRow}`, { hasText: 'hello.js' }).count(),
		search: () => page.locator(`${sel.parts[home]} ${sel.check.searchView}`).count(),
		git: () => page.evaluate(([p, t]) => (document.querySelector(p)?.innerText.includes(t) ? 1 : 0), [sel.parts[home], sel.check.scmTitle]),
		terminal: () => page.locator(`${sel.parts.panel} ${sel.check.terminal}`).count(),
	};
	for (const tab of ctx.tabs) {
		await step(`tab:${tab}`, async () => {
			await tap(`#hd-tabs [data-tab="${tab}"]`);
			await page.waitForTimeout(1800);
			const partName = expected[tab];
			const main = await box(sel.parts[partName]);
			if (!main?.shown) return { ok: false, detail: `${partName} not visible` };
			const others = [];
			for (const [name, s] of Object.entries(sel.parts)) {
				const b = name !== partName && (await box(s));
				if (b?.shown) others.push(`${name} ${Math.round(b.w)}x${Math.round(b.h)}`);
			}
			const hasContent = content[tab] ? (await content[tab]()) > 0 : true;
			const full = main.w >= vw * 0.95 && others.length === 0;
			const detail = `${partName} ${Math.round(main.w)}px${others.length ? `, also: ${others.join(',')}` : ''}${hasContent ? '' : ', expected view missing'}`;
			// builtin mode only promises that the area opens, not that it fills the screen.
			return { ok: hasContent && (ctx.mode === 'builtin' || full), detail };
		});
	}

	await step('bars-layout', async () => {
		const wb = await box(sel.workbench);
		const bars = await box('#hd-root');
		const viewportH = Math.round(await viewportHeight());
		const ok = wb && bars && wb.bottom <= bars.y + 1 && Math.abs(bars.bottom - viewportH) <= 2;
		return { ok, detail: `workbench ends ${Math.round(wb?.bottom)}, bars ${Math.round(bars?.y)}-${Math.round(bars?.bottom)} of ${viewportH}` };
	});

	await step('theme-sync', async () => {
		const colors = await page.evaluate(() => {
			const root = document.getElementById('hd-root');
			return { fg: root.style.getPropertyValue('--vscode-foreground'), bg: getComputedStyle(root).backgroundColor };
		});
		return { ok: !!colors.fg, detail: `bg ${colors.bg}` };
	});

	await step('edit-korean', async () => {
		// A fresh file per device: never rewrite a file the editor may hold unsaved
		// (that makes autosave stop on a conflict), and never let one device's edit
		// satisfy another device's check.
		const { name, file } = editFile;
		await tap('#hd-tabs [data-tab="files"]');
		await page.waitForTimeout(1200);
		await tap(page.locator(`${sel.parts[home]} ${sel.check.listRow}`, { hasText: name }).first());
		await page.waitForTimeout(1500);
		await tap('#hd-tabs [data-tab="code"]');
		await page.waitForTimeout(1500);
		await tap(page.locator(sel.check.editorLine).first(), { x: 4, y: 4 });
		// A tap can land after the first character; jump to the document start
		// (VS Code uses Mac bindings on Apple devices).
		await page.keyboard.press(apple ? 'Meta+ArrowUp' : 'Control+Home');
		await page.waitForTimeout(400);
		await tap('#hd-keys [data-key="input"]');
		await page.fill('#hd-sheet textarea', TYPED + '\n');
		await tap('#hd-sheet button[type="submit"]');
		await page.waitForTimeout(3500); // files.autoSaveDelay 1500
		const disk = readFileSync(file, 'utf8');
		if (disk.startsWith(TYPED)) return { ok: true, detail: 'saved to disk' };
		const why = await page.evaluate(() => ({ paste: document.documentElement.dataset.hdLastPaste ?? 'no paste', active: document.activeElement?.className, sheet: !document.getElementById('hd-sheet')?.hidden }));
		return { ok: false, detail: `disk unchanged; last paste: ${why.paste}; active: ${why.active}; sheet open: ${why.sheet}` };
	});

	await step('accessory-keys', async () => {
		const cursorY = async () => (await box(sel.check.cursor))?.y;
		// Start from the top so ↓ always has somewhere to go (narrow editors wrap a lot).
		await page.keyboard.press(apple ? 'Meta+ArrowUp' : 'Control+Home');
		await page.waitForTimeout(300);
		const before = await cursorY();
		await tap('#hd-keys [data-key="down"]');
		await tap('#hd-keys [data-key="down"]');
		await page.waitForTimeout(400);
		const after = await cursorY();
		return { ok: before != null && after > before, detail: `cursor y ${Math.round(before)} → ${Math.round(after)}` };
	});

	await step('palette-fits', async () => {
		await tap('#hd-keys [data-key="palette"]');
		await page.waitForTimeout(1000);
		const q = await box(sel.quickInput);
		await tap('#hd-keys [data-key="esc"]');
		await page.waitForTimeout(400);
		if (!q?.shown) return { ok: false, detail: 'command palette did not open' };
		return { ok: q.x >= 0 && q.x + q.w <= vw + 1, detail: `x ${Math.round(q.x)}, width ${Math.round(q.w)} of ${vw}` };
	});

	await step('no-layer-errors', async () => ({ ok: errors.length === 0, detail: errors.slice(0, 2).join(' | ').slice(0, 160) }));

	await close();
	return results;
}

// ------------------------------------------------------------------ android

function findAdb() {
	const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
	const homes = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android/Sdk'), process.env.HOME && join(process.env.HOME, 'Library/Android/sdk'), process.env.HOME && join(process.env.HOME, 'Android/Sdk')];
	for (const h of homes) if (h && existsSync(join(h, 'platform-tools', exe))) return join(h, 'platform-tools', exe);
	return 'adb';
}

/**
 * Real Chrome on an emulator or USB phone. `adb reverse` maps the phone's localhost
 * to the proxy, which is also what makes it a secure context (required by VS Code).
 */
async function checkAndroid(serial, ctx) {
	const devices = await android.devices();
	const dev = typeof serial === 'string' ? devices.find((d) => d.serial() === serial) : devices[0];
	if (!dev) throw new Error(`no Android device${typeof serial === 'string' ? ` "${serial}"` : ''} (adb devices is empty; start an emulator or plug in a phone with USB debugging)`);
	const port = new URL(ctx.url).port;
	const adb = findAdb();
	const r = spawnSync(adb, ['-s', dev.serial(), 'reverse', `tcp:${port}`, `tcp:${port}`], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`adb reverse failed: ${r.stderr || r.error}`);
	const chromeVersion = /versionName=(\S+)/.exec(await dev.shell('dumpsys package com.android.chrome').then(String))?.[1];
	console.log(`android: ${dev.model()} (${dev.serial()}), Chrome ${chromeVersion ?? '?'}\n`);
	// Map CSS px to screen px once: tap an invisible full-screen overlay and read where it landed.
	let cal = null;
	const tapAt = async (page, x, y) => {
		if (!cal) {
			await dismissChromePrompts();
			await page.evaluate(() => {
				const o = document.createElement('div');
				o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent';
				o.addEventListener('pointerdown', (e) => { window.__hdCal = { x: e.clientX - (visualViewport?.offsetLeft ?? 0), y: e.clientY - (visualViewport?.offsetTop ?? 0) }; o.remove(); }, { once: true });
				document.body.append(o);
			});
			const [w, h] = /(\d+)x(\d+)/.exec(String(await dev.shell('wm size'))).slice(1).map(Number);
			const sx = Math.round(w / 2), sy = Math.round(h / 2);
			await dev.shell(`input tap ${sx} ${sy}`);
			await page.waitForFunction(() => window.__hdCal, null, { timeout: 10_000 }).catch(async (err) => {
				writeFileSync(join(OUT, 'android-calibration-failed.png'), await dev.screenshot());
				throw new Error(`calibration tap did not reach the page (screen: check-output/android-calibration-failed.png): ${err.message}`);
			});
			const { x: cx, y: cy, dpr } = await page.evaluate(() => ({ ...window.__hdCal, dpr: devicePixelRatio }));
			cal = { dpr, ox: sx - cx * dpr, oy: sy - cy * dpr };
		}
		// Screen position follows the visual viewport, which Chrome pans when the soft keyboard opens.
		const vv = await page.evaluate(() => ({ l: visualViewport?.offsetLeft ?? 0, t: visualViewport?.offsetTop ?? 0 }));
		await dev.shell(`input tap ${Math.round(cal.ox + (x - vv.l) * cal.dpr)} ${Math.round(cal.oy + (y - vv.t) * cal.dpr)}`);
	};
	// Chrome's own first-run / permission sheets sit above the page and swallow taps.
	const dismissChromePrompts = async () => {
		for (const text of ['No thanks', 'Not now', 'No, thanks', 'Dismiss']) {
			await dev.tap({ text }, { timeout: 1500 }).catch(() => {});
		}
	};
	// The "Chrome notifications make things easier" sheet only appears while the
	// permission is undecided; granting it up front keeps it from covering the page.
	await dev.shell('pm grant com.android.chrome android.permission.POST_NOTIFICATIONS').catch(() => {});
	const open = async () => {
		await dev.shell('am force-stop com.android.chrome');
		const context = await dev.launchBrowser();
		const page = context.pages()[0] ?? (await context.newPage());
		await page.waitForTimeout(1500);
		await dismissChromePrompts();
		return { page, close: () => context.close() };
	};
	try {
		return await checkDevice({ name: `Android ${dev.model()}`, open, tapAt }, ctx);
	} finally {
		spawnSync(adb, ['-s', dev.serial(), 'reverse', '--remove', `tcp:${port}`]);
		await dev.close();
	}
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
// Fresh editor state every run: leftover unsaved buffers from an earlier run would
// be restored and can block autosave.
for (const dir of ['workspace', 'data']) rmSync(join(OUT, dir), { recursive: true, force: true });
for (const d of opts.devices) rmSync(join(OUT, d.replace(/\W+/g, '-')), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let proxy;
let exitCode = 1;
try {
	proxy = opts.url ? { url: opts.url, workspace: null, editor: 'external' } : await startProxy(opts);
	if (!proxy.workspace) console.log('note: --url given, edit-korean checks a workspace this script does not control');
	const layerConfig = JSON.parse(readFileSync(join(ROOT, 'layer.config.json'), 'utf8'));
	const selectors = JSON.parse(readFileSync(join(ROOT, 'layer/selectors.json'), 'utf8'));
	console.log(`editor: ${proxy.editor}\nlayer tested with: ${selectors.testedWith.editor} ${selectors.testedWith.version}\nmode: ${opts.mode}\n`);

	const all = [];
	const ctx = { ...proxy, mode: opts.mode, tabs: layerConfig.tabs };
	if (opts.android) {
		all.push(...(await checkAndroid(opts.android, ctx)));
	} else {
		const browser = await chromium.launch();
		for (const name of opts.devices) {
			const device = DEVICES[name];
			if (!device) throw new Error(`unknown Playwright device "${name}"`);
			const { defaultBrowserType, ...deviceOpts } = device;
			const open = async () => {
				const context = await browser.newContext(deviceOpts);
				return { page: await context.newPage(), close: () => context.close() };
			};
			all.push(...(await checkDevice({ name, open }, ctx)));
		}
		await browser.close();
	}

	const failed = all.filter((r) => !r.ok);
	const report = { date: new Date().toISOString(), editor: proxy.editor, mode: opts.mode, testedWith: selectors.testedWith, passed: all.length - failed.length, failed: failed.length, results: all };
	writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
	console.log(`\n${report.passed} passed, ${report.failed} failed → check-output/report.json`);
	exitCode = failed.length ? 1 : 0;
} catch (err) {
	console.error(`check aborted: ${err.message}`);
} finally {
	killTree(proxy?.child);
}
process.exit(exitCode);
