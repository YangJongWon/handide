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
import { removeImportedExtensions } from '../../../../proxy/extensions.mjs';

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
	// Only the layer's own errors fail the check; the user's extensions can throw too.
	const otherErrors = [];
	page.on('pageerror', (e) => {
		const stack = e.stack ?? '';
		if (/__handide|mobile\.js/.test(stack) || !/https?:\/\//.test(stack)) errors.push(e.message);
		else otherErrors.push(`${e.message} @ ${(/https?:\/\/[^\s)]+/.exec(stack)?.[0] ?? '').replace(/^https?:\/\/[^/]+/, '').slice(0, 80)}`);
	});
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

	const shownPartsNow = () =>
		page.evaluate((parts) => {
			const out = {};
			for (const [name, s] of Object.entries(parts)) {
				const el = document.querySelector(s);
				const r = el?.getBoundingClientRect();
				if (r && r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none') out[name] = Math.round(r.width);
			}
			return out;
		}, sel.parts);

	// Created before the page loads: on a first-run server the file watcher can take
	// longer than the check waits, and a file missing from the tree fails the edit step.
	const slug = deviceName.replace(/\W+/g, '-').toLowerCase();
	const editName = `edit-${slug}.js`;
	const editFile = { name: editName, file: ctx.workspace ? join(ctx.workspace, editName) : null };
	if (editFile.file) writeFileSync(editFile.file, SAMPLE);
	// A sub folder the folder-change step opens through the drawer's folder picker.
	const subFolder = ctx.workspace ? { name: `sub-${slug}` } : null;
	if (subFolder) {
		mkdirSync(join(ctx.workspace, subFolder.name), { recursive: true });
		writeFileSync(join(ctx.workspace, subFolder.name, 'inside.txt'), 'hello\n');
	}

	await step('layer-injected', async () => {
		await page.goto(ctx.url, { timeout: 120_000 });
		await page.waitForSelector('#hd-root', { timeout: 120_000 });
		await page.waitForSelector(sel.workbench, { timeout: 120_000 });
		({ vw, apple } = await page.evaluate(() => ({ vw: innerWidth, apple: /iPhone|iPad|Macintosh/.test(navigator.userAgent) })));
		return { ok: true, detail: `viewport width ${vw}` };
	});

	// Before trust (companion off): VS Code may restore its side bars next to the editor.
	// Open both the way that happens, and expect the layer to close them again.
	await step('restricted-layout', async () => {
		await page.waitForTimeout(4000);
		// Every part that was ever laid out, sampled on each DOM change: the layer may close
		// them before the next frame.
		await page.evaluate((parts) => {
			window.__hdSeen = new Set();
			const sample = () => {
				if (!window.__hdSeen) return obs.disconnect();
				for (const [name, s] of Object.entries(parts)) {
					const r = document.querySelector(s)?.getBoundingClientRect();
					if (r && r.width > 0 && r.height > 0) window.__hdSeen.add(name);
				}
			};
			const obs = new MutationObserver(sample);
			obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
			sample();
		}, sel.parts);
		const mod = apple ? 'Meta' : 'Control';
		// A trust prompt from a restored terminal is modal and would swallow the keys.
		if (await page.locator(sel.dialog).count()) await page.keyboard.press('Escape');
		await page.waitForTimeout(500);
		await tap(sel.parts.editor).catch(() => {}); // keys go to the workbench, not to a leftover focus
		await page.waitForTimeout(300);
		await page.keyboard.press(`${mod}+B`);
		await page.keyboard.press(`${mod}+Alt+B`);
		await page.waitForTimeout(1500);
		const opened = (await page.evaluate(() => [...window.__hdSeen])).join(', ');
		await page.waitForTimeout(5000);
		await page.evaluate(() => (window.__hdSeen = null));
		const parts = await shownPartsNow();
		const names = Object.keys(parts);
		const reproduced = /sidebar/.test(opened) && /auxiliarybar/.test(opened);
		return {
			ok: reproduced && names.length === 1 && names[0] === 'editor',
			detail: `seen: ${opened || 'nothing'}${reproduced ? '' : ' (side bars did not open: test not reproduced)'}; now: ${names.join(', ') || 'nothing'}`,
		};
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

	const builtinMode = ctx.mode === 'builtin';
	const menuItems = ctx.menu ?? ['files', 'terminal', 'ai', 'quickOpen', 'palette', 'save', 'undo', 'redo'];
	const title = async () => (await page.locator('#hd-title-text').textContent()).trim();
	const drawerOpen = () => page.evaluate(() => document.documentElement.classList.contains('hd-drawer-open'));
	const keysShown = () => page.evaluate(() => document.getElementById('hd-root')?.dataset.keys === '1');
	// The menu sheet opens from the floating button, or from the accessory keys' ☰ while typing.
	const menu = async (item) => {
		await tap((await keysShown()) ? '#hd-keys [data-key="menu"]' : '#hd-fab');
		await page.waitForTimeout(600);
		await tap(`#hd-menu [data-item="${item}"]`);
	};
	const closeBar = () => tap('#hd-viewbar [data-act="back"]');
	// Accessory keys follow the soft keyboard. Emulation has none: shrink the viewport the
	// way a keyboard does. On a real phone, tapping the editor raises the real one.
	let fullViewport = null;
	const showKeyboard = async () => {
		if (!tapAt && !fullViewport) {
			fullViewport = page.viewportSize();
			await page.setViewportSize({ width: fullViewport.width, height: fullViewport.height - 330 });
		}
		await page.waitForFunction(() => document.getElementById('hd-root')?.dataset.keys === '1', null, { timeout: 10_000 });
	};
	const hideKeyboard = async () => {
		if (fullViewport) {
			await page.setViewportSize(fullViewport);
			fullViewport = null;
		} else if (await keysShown()) await tap('#hd-keys [data-key="hideKeyboard"]');
		await page.waitForTimeout(600);
	};
	const shownParts = async () => {
		const out = {};
		for (const [name, s] of Object.entries(sel.parts)) {
			const b = await box(s);
			if (b?.shown) out[name] = b;
		}
		return out;
	};
	const describe = (parts) => Object.entries(parts).map(([n, b]) => `${n} ${Math.round(b.w)}x${Math.round(b.h)}`).join(', ') || 'nothing';

	// Views, driven through the UI the way a user would: [check, menu item, how, parts that must be visible, content check]
	const content = {
		terminal: () => page.locator(`${sel.parts.panel} ${sel.check.terminal}`).count(),
	};
	// The code is the only screen; the terminal and AI are drawers over it.
	const views = [
		['view:editor', null, async () => {}, ['editor']],
		['view:terminal-drawer', 'terminal', () => menu('terminal'), ['editor', 'panel'], 'terminal'],
		['view:terminal-close', 'terminal', closeBar, ['editor']],
		['view:ai-drawer', 'ai', () => menu('ai'), ['auxiliarybar']],
		['view:ai-close', 'ai', closeBar, ['editor']],
	];
	for (const [name, item, how, want, contentKey] of views) {
		if (item && !menuItems.includes(item)) continue;
		await step(name, async () => {
			await how();
			await page.waitForTimeout(2500);
			const parts = await shownParts();
			const names = Object.keys(parts);
			const hasContent = contentKey ? (await content[contentKey]()) > 0 : true;
			let ok;
			const builtinPart = want[want.length - 1];
			if (builtinMode) ok = names.includes(builtinPart); // builtin: the area opens, no phone layout
			else {
				ok = want.length === names.length && want.every((p) => names.includes(p)) && want.every((p) => parts[p].w >= vw * 0.95);
				if (ok && want.length === 2) ok = parts.editor.bottom <= parts.panel.y + 1; // editor above the docked terminal
			}
			return { ok: ok && hasContent, detail: describe(parts) + (hasContent ? '' : ', expected view missing') };
		});
		if (name === 'view:ai-drawer' && !builtinMode) {
			await step('agents', agentsStep);
			await step('voice', voiceStep);
		}
	}

	// The AI bar's title lists the secondary side bar's agents (VS Code's tabs for them
	// are hidden); picking one shows it. Ends on VS Code's Chat for the voice step.
	async function agentsStep() {
		await tap('#hd-viewbar [data-act="agents"]');
		await page.waitForSelector('#hd-agents:not([hidden]) .hd-agent', { timeout: 10_000 }).catch(() => {});
		const names = await page.$$eval('#hd-agents .hd-agent > span', (els) => els.map((e) => e.textContent.trim()));
		if (!names.includes('Chat')) return { ok: false, detail: `agent list: ${names.join(', ') || 'empty'}` };
		// An extension from the primary side bar or the panel, when the machine has one: its
		// views are moved into the secondary side bar and shown there.
		let moved = 'no primary side bar extension installed';
		const movable = page.locator('#hd-agents [data-moved]').first();
		if (await movable.count()) {
			const want = (await movable.locator('span').first().textContent()).trim();
			await tap(`#hd-agents [data-agent="${await movable.getAttribute('data-agent')}"]`);
			await page.waitForTimeout(3000);
			const parts = Object.keys(await shownParts());
			const label = await page.evaluate((s) => document.querySelector(s)?.textContent.trim(), sel.partTitleLabels.auxiliarybar);
			const panes = await page.evaluate(() => [...document.querySelectorAll('.part.auxiliarybar .pane-header, .part.auxiliarybar .title-label')].map((e) => e.textContent.trim()).join(' | '));
			if (parts.join() !== 'auxiliarybar' || !panes.toLowerCase().includes(want.toLowerCase().split(' ')[0])) {
				return { ok: false, detail: `picked "${want}": parts ${parts.join(', ')}; side bar shows "${label}" / ${panes}` };
			}
			moved = `"${want}" shown`;
			await tap('#hd-viewbar [data-act="agents"]');
			await page.waitForSelector('#hd-agents:not([hidden]) .hd-agent', { timeout: 10_000 }).catch(() => {});
		}
		await tap('#hd-agents [data-agent="workbench.action.chat.open"]');
		await page.waitForTimeout(2500);
		const shown = await page.evaluate((s) => document.querySelector(s)?.textContent.trim(), sel.partTitleLabels.auxiliarybar);
		const bar = (await page.locator('#hd-viewbar .hd-agent-name').textContent())?.trim();
		const hasInput = (await page.locator(sel.chatInput).count()) > 0;
		return {
			ok: /chat/i.test(shown ?? '') && bar === shown && hasInput,
			detail: `${names.length} listed; ${moved}; then showing "${shown}", bar "${bar}"${hasInput ? '' : ', no chat input'}`,
		};
	}

	// Voice input in the AI bar. No microphone here: a stand-in recognizer "hears" one
	// phrase, which must land in the chat input.
	async function voiceStep() {
		const phrase = '음성으로 입력한 문장';
		await page.evaluate((text) => {
			window.SpeechRecognition = class {
				start() {
					setTimeout(() => {
						const result = Object.assign([{ transcript: text }], { isFinal: true });
						this.onresult?.({ resultIndex: 0, results: [result] });
						setTimeout(() => this.onend?.(), 300);
					}, 500);
				}
				stop() {
					this.onend?.();
				}
			};
		}, phrase);
		await tap('#hd-viewbar [data-act="voice"]');
		await page.waitForTimeout(200);
		const listening = await page.evaluate(() => !document.getElementById('hd-voice').hidden && !!document.querySelector('#hd-viewbar .hd-listening'));
		await page.waitForTimeout(1500);
		const text = await page.evaluate(() => (document.querySelector('.part.auxiliarybar .interactive-input-editor .view-lines')?.textContent ?? '').replace(/\u00a0/g, ' ')); // the editor renders spaces as nbsp
		const stopped = await page.evaluate(() => document.getElementById('hd-voice').hidden);
		await page.evaluate(() => delete window.SpeechRecognition);
		return {
			ok: listening && text.includes(phrase) && stopped,
			detail: `${listening ? 'listening shown' : 'no listening state'}; chat input "${text.trim().slice(0, 40)}"; ${stopped ? 'stopped' : 'still listening'}`,
		};
	}

	await step('drawer', async () => {
		await menu('files');
		await page.waitForTimeout(2500);
		if (!(await drawerOpen())) return { ok: false, detail: 'drawer did not open' };
		const row = page.locator('#hd-drawer .hd-row', { hasText: editFile.name }).first();
		if (!(await row.count())) return { ok: false, detail: `${editFile.name} not in the tree` };
		if (builtinMode) {
			await tap('#hd-scrim', { x: vw - 10, y: 300 });
			return { ok: true, detail: 'tree shown (opening files needs the companion extension)' };
		}
		await tap(row);
		await page.waitForTimeout(2500);
		const t = await title();
		const stillOpen = await drawerOpen();
		return { ok: t === editFile.name && !stillOpen, detail: `title "${t}", drawer ${stillOpen ? 'still open' : 'closed'}` };
	});

	await step('swipe', async () => {
		if (!target.swipe) return { ok: true, detail: 'skipped (no swipe support)' };
		const h = Math.round(await viewportHeight());
		await target.swipe(page, 4, h / 2, 230, h / 2);
		await page.waitForTimeout(900);
		const opened = await drawerOpen();
		await target.swipe(page, 280, h / 2, 40, h / 2);
		await page.waitForTimeout(900);
		const closed = !(await drawerOpen());
		// A swipe used to leave VS Code's gesture handler thinking a finger was down,
		// after which no tap worked: taps must still work now.
		await menu('files');
		await page.waitForTimeout(900);
		const tapOpens = await drawerOpen();
		await tap('#hd-scrim', { x: vw - 10, y: 300 });
		await page.waitForTimeout(900);
		const tapCloses = !(await drawerOpen());
		// The AI drawer from the right edge, closed again from the left edge.
		const view = () => page.evaluate(() => document.documentElement.dataset.hdView);
		await target.swipe(page, vw - 4, h / 2, vw - 230, h / 2);
		await page.waitForTimeout(1500);
		const aiOpens = (await view()) === 'ai';
		await target.swipe(page, 4, h / 2, 230, h / 2);
		await page.waitForTimeout(1500);
		const aiCloses = (await view()) === 'editor' && !(await drawerOpen());
		return {
			ok: opened && closed && tapOpens && tapCloses && aiOpens && aiCloses,
			detail: `left edge opens files ${opened}, swipe closes ${closed}, tap after swipe opens ${tapOpens}, scrim closes ${tapCloses}, right edge opens AI ${aiOpens}, left edge closes it ${aiCloses}`,
		};
	});

	await step('bars-layout', async () => {
		// Full screen: the workbench fills the visible area, the floating button sits inside it.
		const wb = await box(sel.workbench);
		const fab = await box('#hd-fab');
		const viewportH = Math.round(await viewportHeight());
		const fabInside = fab?.shown && fab.x >= 0 && fab.x + fab.w <= vw + 1 && fab.y >= wb?.y && fab.bottom <= viewportH;
		const ok = wb && Math.abs(wb.y) <= 1 && Math.abs(wb.bottom - viewportH) <= 2 && fabInside;
		return { ok, detail: `workbench ${Math.round(wb?.y)}-${Math.round(wb?.bottom)} of ${viewportH}, button ${fab?.shown ? `at ${Math.round(fab.x)},${Math.round(fab.y)}` : 'hidden'}` };
	});

	await step('theme-sync', async () => {
		const colors = await page.evaluate(() => ({
			fg: document.documentElement.style.getPropertyValue('--vscode-foreground'),
			bg: getComputedStyle(document.getElementById('hd-menu')).backgroundColor,
		}));
		return { ok: !!colors.fg, detail: `bg ${colors.bg}` };
	});

	await step('edit-korean', async () => {
		// A fresh file per device: never rewrite a file the editor may hold unsaved
		// (that makes autosave stop on a conflict), and never let one device's edit
		// satisfy another device's check.
		const { name, file } = editFile;
		if (builtinMode) {
			await menu('quickOpen');
			await page.waitForTimeout(800);
			await page.keyboard.type(name);
			await page.waitForTimeout(800);
			await page.keyboard.press('Enter');
			await page.waitForTimeout(1500);
		} else if ((await title()) !== name) {
			await menu('files');
			await page.waitForTimeout(1500);
			await tap(page.locator('#hd-drawer .hd-row', { hasText: name }).first());
			await page.waitForTimeout(1500);
		}
		await tap(page.locator(sel.check.editorLine).first(), { x: 4, y: 4 });
		await showKeyboard();
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
		const shown = await keysShown();
		if (shown) {
			await tap('#hd-keys [data-key="down"]');
			await tap('#hd-keys [data-key="down"]');
		}
		await page.waitForTimeout(400);
		const after = await cursorY();
		await hideKeyboard();
		const keysGone = !(await keysShown());
		return {
			ok: shown && before != null && after > before && keysGone,
			detail: `keys ${shown ? 'shown' : 'not shown'} with the keyboard, cursor y ${Math.round(before)} → ${Math.round(after)}, ${keysGone ? 'hidden' : 'still shown'} without it`,
		};
	});

	await step('palette-fits', async () => {
		await menu('palette');
		await page.waitForTimeout(1000);
		const q = await box(sel.quickInput);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		if (!q?.shown) return { ok: false, detail: 'command palette did not open' };
		return { ok: q.x >= 0 && q.x + q.w <= vw + 1, detail: `x ${Math.round(q.x)}, width ${Math.round(q.w)} of ${vw}` };
	});

	if (!builtinMode && subFolder) {
		await step('folder-change', async () => {
			await menu('files');
			await page.waitForTimeout(1500);
			await tap('#hd-drawer-head [aria-label="폴더 변경"]'); // the picker starts at the parent of the open folder
			await page.waitForTimeout(1200);
			await tap(page.locator('#hd-drawer .hd-row', { hasText: 'workspace' }).first());
			await page.waitForTimeout(1200);
			await tap(page.locator('#hd-drawer .hd-row', { hasText: subFolder.name }).first());
			await page.waitForTimeout(1200);
			await Promise.all([page.waitForNavigation({ timeout: 60_000 }), tap('.hd-picker-actions .hd-primary')]);
			await page.waitForSelector('#hd-fab', { timeout: 120_000 });
			await grantTrust(page); // a newly opened folder asks for trust again
			await page.waitForTimeout(5000);
			await menu('files');
			await page.waitForTimeout(2500);
			const folder = await page.locator('.hd-drawer-title strong').innerText();
			const hasFile = (await page.locator('#hd-drawer .hd-row', { hasText: 'inside.txt' }).count()) > 0;
			return { ok: folder === subFolder.name && hasFile, detail: `drawer shows "${folder}"${hasFile ? ' with its file' : ''}` };
		});
	}

	await step('no-layer-errors', async () => ({
		ok: errors.length === 0,
		detail: (errors.length ? errors.slice(0, 2).join(' | ') : otherErrors.length ? `not the layer: ${[...new Set(otherErrors)].slice(0, 2).join(' | ')}` : '').slice(0, 200),
	}));

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
	const ensureCal = async (page) => {
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
	};
	// Screen position follows the visual viewport, which Chrome pans when the soft keyboard opens.
	const toScreen = async (page, x, y) => {
		await ensureCal(page);
		const vv = await page.evaluate(() => ({ l: visualViewport?.offsetLeft ?? 0, t: visualViewport?.offsetTop ?? 0 }));
		return [Math.round(cal.ox + (x - vv.l) * cal.dpr), Math.round(cal.oy + (y - vv.t) * cal.dpr)];
	};
	const tapAt = async (page, x, y) => {
		const [sx, sy] = await toScreen(page, x, y);
		await dev.shell(`input tap ${sx} ${sy}`);
	};
	const swipe = async (page, x0, y0, x1, y1) => {
		const [a, b] = await toScreen(page, x0, y0);
		const [c, d] = await toScreen(page, x1, y1);
		await dev.shell(`input swipe ${Math.max(1, a)} ${b} ${c} ${d} 250`);
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
		return await checkDevice({ name: `Android ${dev.model()}`, open, tapAt, swipe }, ctx);
	} finally {
		spawnSync(adb, ['-s', dev.serial(), 'reverse', '--remove', `tcp:${port}`]);
		await dev.close();
	}
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
// Fresh editor state every run: leftover unsaved buffers from an earlier run would
// be restored and can block autosave. The linked desktop extensions are unlinked first:
// they point into the desktop editor's own folders.
await removeImportedExtensions(join(OUT, 'data', 'extensions'));
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
	const ctx = { ...proxy, mode: opts.mode, menu: layerConfig.menu };
	if (opts.android) {
		all.push(...(await checkAndroid(opts.android, ctx)));
	} else {
		const browser = await chromium.launch();
		for (const name of opts.devices) {
			const device = DEVICES[name];
			if (!device) throw new Error(`unknown Playwright device "${name}"`);
			const { defaultBrowserType, ...deviceOpts } = device;
			let context;
			const open = async () => {
				context = await browser.newContext(deviceOpts);
				return { page: await context.newPage(), close: () => context.close() };
			};
			// A real touch swipe (start, moves, end) through the DevTools protocol.
			const swipe = async (page, x0, y0, x1, y1) => {
				const cdp = await context.newCDPSession(page);
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
				for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y: y0 + ((y1 - y0) * i) / 8 }] });
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				await cdp.detach();
			};
			all.push(...(await checkDevice({ name, open, swipe }, ctx)));
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
