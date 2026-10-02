// handide mobile layer. Injected by the proxy into the real VS Code web UI.
//
// A full-screen code editor with everything else one gesture away:
//
//   ┌ editor (VS Code), full screen ─────────────┐
//   │                                       (◉)  │  floating button (draggable) → menu sheet
//   ├─ terminal: bottom drawer (VS Code panel) ──┤  grab bar: swipe down / ⌄ closes
//   └─ accessory keys, only while typing ────────┘
//   Files = left drawer (menu, or swipe from the left edge).
//   AI = right drawer (menu, or swipe from the right edge): VS Code's secondary side bar.
//   There are no other screens: the code is the only "tab".
//
// It never touches VS Code internals. It talks to VS Code through
//  - the command bridge (proxy ↔ companion extension): official commands with
//    arguments, e.g. vscode.open / vscode.openFolder / handide.view,
//  - key chords bound by the companion extension (fallback when the bridge is down),
//  - the DOM only to read layout state (selectors.json) and to insert text.
const BASE = '/__handide/';

const KEY_DEFS = {
	menu: { icon: 'menu', menu: true },
	esc: { label: 'Esc', key: 'Escape', keyCode: 27 },
	tab: { label: '⇥', key: 'Tab', keyCode: 9 },
	left: { label: '←', key: 'ArrowLeft', keyCode: 37 },
	up: { label: '↑', key: 'ArrowUp', keyCode: 38 },
	down: { label: '↓', key: 'ArrowDown', keyCode: 40 },
	right: { label: '→', key: 'ArrowRight', keyCode: 39 },
	home: { label: 'Home', key: 'Home', keyCode: 36 },
	end: { label: 'End', key: 'End', keyCode: 35 },
	ctrl: { label: 'Ctrl', sticky: 'ctrlKey' },
	alt: { label: 'Alt', sticky: 'altKey' },
	shift: { label: 'Shift', sticky: 'shiftKey' },
	undo: { icon: 'discard', action: 'undo' },
	redo: { icon: 'redo', action: 'redo' },
	save: { icon: 'save', action: 'save' },
	find: { icon: 'search', action: 'find' },
	quickOpen: { icon: 'go-to-file', action: 'quickOpen' },
	palette: { icon: 'terminal-cmd', action: 'commandPalette' },
	input: { label: '가', input: true },
};

// Menu sheet tiles: the three drawers, then actions. `terminal` and `ai` toggle.
const MENU_DEFS = {
	files: { icon: 'files', label: '파일' },
	terminal: { icon: 'terminal', label: '터미널', view: 'terminalDock' },
	ai: { icon: 'sparkle', label: 'AI', view: 'ai' },
	quickOpen: { icon: 'go-to-file', label: '파일 찾기', action: 'quickOpen' },
	palette: { icon: 'terminal-cmd', label: '명령', action: 'commandPalette' },
	save: { icon: 'save', label: '저장', action: 'save' },
	undo: { icon: 'discard', label: '실행 취소', action: 'undo' },
	redo: { icon: 'redo', label: '다시 실행', action: 'redo' },
	find: { icon: 'search', label: '찾기', action: 'find' },
};
const DEFAULT_MENU = ['files', 'terminal', 'ai', 'quickOpen', 'palette', 'save', 'undo', 'redo'];

// What each view looks like, as the set of VS Code parts that must be visible.
const VIEW_PARTS = {
	editor: ['editor'],
	terminalDock: ['editor', 'panel'],
	ai: ['auxiliarybar'],
};

// The bar laid over the title strip of a drawer's part: [icon, label, action].
// `side` is where the drawer comes from, and so which way it closes.
const VIEW_BARS = {
	terminalDock: { part: 'panel', title: '터미널', side: 'bottom', actions: [['add', '새 터미널', 'newTerminal'], ['trash', '터미널 종료', 'killTerminal']] },
	ai: { part: 'auxiliarybar', title: 'AI', side: 'right', actions: [['add', '새 채팅', 'newChat']] },
};

const state = {
	config: null,
	commands: null,
	selectors: null,
	view: 'editor',
	sticky: { ctrlKey: false, altKey: false, shiftKey: false },
	keysOn: false, // accessory keys: a text input has focus and the keyboard is up
	lastInput: null,
	bridge: false,
	folder: null, // { name, path }
	activePath: null,
	tree: new Map(), // dir path → { entries, open }
	picker: null, // { path, parent, entries } while choosing a folder
	drawerOpen: false,
	menuOpen: false,
	viewbarFor: null,
	fab: loadFab(),
};

// ---------------------------------------------------------------- bridge + fs

async function api(path, { method = 'GET', body } = {}) {
	const res = await fetch(path, {
		method,
		headers: { 'x-handide': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	return res.json();
}

/** Runs a VS Code command with arguments through the companion extension. */
async function bridgeCall(command, ...args) {
	try {
		const r = await api(`${BASE}bridge/call`, { method: 'POST', body: { command, args } });
		if (!r.ok) throw new Error(r.error);
		state.bridge = true;
		return r.result;
	} catch (err) {
		console.warn(`[handide] ${command}: ${err.message}`);
		return undefined;
	}
}

async function waitForBridge() {
	for (let i = 0; i < 40; i++) {
		const s = await api(`${BASE}bridge/status`).catch(() => ({}));
		if (s.connected) return (state.bridge = true);
		await new Promise((r) => setTimeout(r, 1500));
	}
	return false;
}

async function refreshState() {
	const s = await bridgeCall('handide.state');
	if (!s) return;
	const folder = s.folders?.[0] ?? null;
	const changed = folder?.path !== state.folder?.path;
	state.folder = folder;
	state.activePath = s.active?.path ?? null;
	if (changed) {
		state.tree.clear();
		if (folder) await loadDir(folder.path, true);
	}
	renderDrawer();
	renderMenuHead();
}

/**
 * The open folder as the page itself knows it: ?folder= after a folder switch,
 * otherwise the workbench configuration VS Code embeds in the page. Lets the drawer
 * work before (or without) the companion extension.
 */
function pageFolder() {
	let p = new URLSearchParams(location.search).get('folder');
	if (!p) {
		try {
			p = JSON.parse(document.getElementById('vscode-workbench-web-configuration').dataset.settings).folderUri?.path;
		} catch {
			// no configuration: nothing to show yet
		}
	}
	if (!p) return null;
	p = decodeURIComponent(p);
	if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1).replaceAll('/', '\\'); // "/c:/Users/x" → "c:\Users\x"
	return { name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p };
}

async function loadDir(path, open) {
	const r = await api(`${BASE}fs?path=${encodeURIComponent(path)}`).catch(() => null);
	if (!r?.ok) return;
	state.tree.set(path, { entries: r.entries, open: open ?? state.tree.get(path)?.open ?? false });
}

// ---------------------------------------------------------------- keys → VS Code

function keyCodeOf(key) {
	if (/^F\d+$/.test(key)) return 111 + Number(key.slice(1));
	if (key.length === 1) return key.toUpperCase().charCodeAt(0);
	return 0;
}

/** Sends a synthetic keydown that VS Code's keybinding service resolves like a real one. */
function sendKey({ key, keyCode = keyCodeOf(key), code = key, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false, target }) {
	const el = target || focusTarget();
	for (const type of ['keydown', 'keyup']) {
		const e = new KeyboardEvent(type, { key, code, ctrlKey, altKey, shiftKey, metaKey, bubbles: true, cancelable: true });
		Object.defineProperty(e, 'keyCode', { get: () => keyCode });
		Object.defineProperty(e, 'which', { get: () => keyCode });
		el.dispatchEvent(e);
	}
}

const LAYER_UI = '#hd-root, #hd-fab, #hd-menu, #hd-drawer, #hd-viewbar';

function focusTarget() {
	const active = document.activeElement;
	if (active && active !== document.body && !active.closest(LAYER_UI)) return active;
	if (state.lastInput?.isConnected) return state.lastInput;
	return document.querySelector(state.selectors.workbench) || document.body;
}

function chord(key) {
	const [ctrl, alt, shift] = ['ctrl', 'alt', 'shift'].map((m) => state.commands.modifiers.includes(m));
	sendKey({ key, ctrlKey: ctrl, altKey: alt, shiftKey: shift });
}

// Fallback when the companion extension can't be used (companion.mode = "builtin"):
// VS Code's own default shortcuts. Areas open, but not in the phone layout.
const APPLE = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
const k = (key, code, keyCode, mods) => ({ key, code, keyCode, ...mods });
const MOD = APPLE ? { metaKey: true } : { ctrlKey: true };
const BUILTIN_VIEWS = {
	editor: k('1', 'Digit1', 49, MOD),
	terminalDock: k('`', 'Backquote', 192, { ctrlKey: true }),
	ai: APPLE ? k('I', 'KeyI', 73, { ctrlKey: true, metaKey: true }) : k('I', 'KeyI', 73, { ctrlKey: true, altKey: true }),
};
const BUILTIN_ACTIONS = {
	quickOpen: k('P', 'KeyP', 80, MOD),
	commandPalette: k('P', 'KeyP', 80, { ...MOD, shiftKey: true }),
	save: k('S', 'KeyS', 83, MOD),
	undo: k('Z', 'KeyZ', 90, MOD),
	redo: APPLE ? k('Z', 'KeyZ', 90, { metaKey: true, shiftKey: true }) : k('Y', 'KeyY', 89, { ctrlKey: true }),
	find: k('F', 'KeyF', 70, MOD),
	newTerminal: k('`', 'Backquote', 192, { ctrlKey: true, shiftKey: true }),
};
// VS Code's default toggles, which work even in Restricted Mode (companion off).
// Toggles: sent only for a part the DOM shows as open.
const CLOSE_PART_KEYS = {
	sidebar: k('B', 'KeyB', 66, MOD),
	auxiliarybar: k('B', 'KeyB', 66, { ...MOD, altKey: true }),
	panel: k('J', 'KeyJ', 74, MOD),
};
const builtin = () => state.config.companion?.mode === 'builtin';

function runAction(name) {
	if (builtin()) {
		if (BUILTIN_ACTIONS[name]) sendKey(BUILTIN_ACTIONS[name]);
		return;
	}
	const action = state.commands.actions[name];
	if (!action) return;
	if (state.bridge) bridgeCall(action.command);
	else if (action.key) chord(action.key);
}

// ---------------------------------------------------------------- views

function visiblePart(name) {
	const el = document.querySelector(state.selectors.parts[name]);
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
}
const visibleParts = () => Object.keys(state.selectors.parts).filter(visiblePart);

function showView(view) {
	state.view = view;
	// While VS Code carries out the switch, the layout is in between: don't let
	// syncViewFromLayout read that as the user closing something.
	state.settlingUntil = Date.now() + 4500;
	closeDrawer();
	closeMenu();
	render();
	if (builtin()) {
		// Ctrl+` toggles the terminal: pressing it again while it is open would close it.
		const terminalAlreadyOpen = view === 'terminalDock' && visiblePart('panel');
		if (BUILTIN_VIEWS[view] && !terminalAlreadyOpen) sendKey(BUILTIN_VIEWS[view]);
		return;
	}
	if (state.bridge) bridgeCall('handide.view', { view });
	else if (state.commands.tabs[view]) chord(state.commands.tabs[view]);
	settleView(view);
	if (view === 'editor') setTimeout(() => focusTarget().focus?.(), 200);
}

// The extension opens the right areas with idempotent commands. Whether the panel
// fills the screen is a toggle only the DOM reveals, so the layer finishes the job:
// it toggles "maximize panel" only when the panel is open but the layout is wrong,
// and never again until the layout visibly changed (so it can't undo its own toggle).
function settleView(view) {
	const want = VIEW_PARTS[view];
	if (!want) return;
	const started = Date.now();
	let resent = false;
	let toggledAt = 0;
	let layoutAtToggle = '';
	const tick = () => {
		if (state.view !== view || Date.now() - started > 4000) return;
		const shown = visibleParts();
		const key = shown.join(',');
		if (want.length === shown.length && want.every((p) => shown.includes(p))) {
			state.settlingUntil = 0; // done
			return;
		}
		if (want.includes('panel') && shown.includes('panel')) {
			const needMax = !want.includes('editor') && shown.includes('editor');
			const needRestore = want.includes('editor') && !shown.includes('editor');
			if ((needMax || needRestore) && (!toggledAt || (key !== layoutAtToggle && Date.now() - toggledAt > 600))) {
				toggledAt = Date.now();
				layoutAtToggle = key;
				runAction('toggleMaximizedPanel');
			}
		} else if (!resent && Date.now() - started > 1200) {
			resent = true;
			if (state.bridge) bridgeCall('handide.view', { view });
			else if (state.commands.tabs[view]) chord(state.commands.tabs[view]);
		}
		setTimeout(tick, 300);
	};
	setTimeout(tick, 300);
}

/**
 * Keeps the screen to the code plus at most the drawer the user opened, whatever VS Code
 * does by itself: it restores its saved layout (side bar, panel and chat side by side)
 * when the folder is trusted, and extensions reveal their views. A drawer VS Code
 * closed is followed; anything VS Code opened is closed again.
 */
let lastEnforced = 0;
let recheck = 0;
/** Looks again once a pause is over, even if nothing in the DOM changes by then. */
function syncLater(at) {
	clearTimeout(recheck);
	recheck = setTimeout(syncViewFromLayout, Math.max(0, at - Date.now()) + 50);
}
function syncViewFromLayout() {
	if (Date.now() < (state.settlingUntil || 0)) return syncLater(state.settlingUntil);
	const shown = visibleParts();
	let view = state.view;
	if (view === 'terminalDock' && !shown.includes('panel') && shown.includes('editor')) view = 'editor';
	if (view === 'ai' && !shown.includes('auxiliarybar') && shown.includes('editor')) view = 'editor';
	const stray = shown.filter((p) => !VIEW_PARTS[view].includes(p) && CLOSE_PART_KEYS[p]);
	if (view !== state.view) {
		state.view = view;
		render();
	}
	if (!stray.length) return;
	if (Date.now() - lastEnforced < 3000) return syncLater(lastEnforced + 3000);
	// Not while the user is in quick open or a dialog: the keys would take their focus.
	const busy = [state.selectors.quickInput, state.selectors.dialog].some((s) => document.querySelector(s)?.getBoundingClientRect().height > 0);
	if (busy) return syncLater(Date.now() + 1000);
	lastEnforced = Date.now();
	syncLater(lastEnforced + 3000); // confirm it worked
	if (state.bridge && !builtin()) return showView(view);
	// No companion (Restricted Mode, or builtin mode): close them with VS Code's own keys.
	for (const part of stray) sendKey({ ...CLOSE_PART_KEYS[part], target: document.querySelector(state.selectors.workbench) });
}

function pressMenu(name) {
	const def = MENU_DEFS[name];
	closeMenu();
	if (name === 'files') return openDrawer();
	if (def.view) return showView(state.view === def.view ? 'editor' : def.view);
	if (def.action) runAction(def.action);
}

// ---------------------------------------------------------------- sticky modifiers

function consumeSticky() {
	const mods = { ...state.sticky };
	state.sticky = { ctrlKey: false, altKey: false, shiftKey: false };
	render();
	return mods;
}

const anySticky = () => state.sticky.ctrlKey || state.sticky.altKey || state.sticky.shiftKey;

// Soft keyboards report keyCode 229 for letters, so sticky Ctrl/Alt is applied at
// the `beforeinput` stage: the typed character becomes a chord instead of text.
function onBeforeInput(e) {
	if (!anySticky() || e.inputType !== 'insertText' || !e.data || e.data.length !== 1) return;
	e.preventDefault();
	e.stopImmediatePropagation();
	const mods = consumeSticky();
	const ch = e.data;
	sendKey({ key: ch.toLowerCase(), code: `Key${ch.toUpperCase()}`, keyCode: keyCodeOf(ch), ...mods, target: e.target });
}

// ---------------------------------------------------------------- input sheet

function openInputSheet() {
	const target = focusTarget();
	const sheet = document.getElementById('hd-sheet');
	const area = sheet.querySelector('textarea');
	sheet.hidden = false;
	area.value = '';
	area.focus();
	render();
	sheet.onsubmit = (e) => {
		e.preventDefault();
		sheet.hidden = true;
		if (area.value) pasteInto(target, area.value);
		render();
	};
}

function closeInputSheet() {
	document.getElementById('hd-sheet').hidden = true;
	render();
}

/**
 * Inserts text at the cursor.
 * - Editor using EditContext (current Chrome, desktop and Android): a `textupdate`,
 *   the same path the soft keyboard uses. A synthetic paste is *accepted* there but
 *   inserts nothing on Android Chrome, so it is not used for the editor.
 * - Anything else (terminal, VS Code inputs, browsers without EditContext): a paste.
 */
function pasteInto(target, text) {
	target.focus?.();
	let how;
	const ec = target.editContext;
	if (ec && typeof TextUpdateEvent === 'function') {
		const start = ec.selectionStart;
		const caret = start + text.length;
		ec.dispatchEvent(new TextUpdateEvent('textupdate', { text, updateRangeStart: start, updateRangeEnd: ec.selectionEnd, selectionStart: caret, selectionEnd: caret }));
		how = 'textupdate';
	} else {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		const handled = !target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		how = `paste handled=${handled}`;
	}
	// Breadcrumb for `npm run check` when an insert goes missing.
	document.documentElement.dataset.hdLastPaste = `${target.tagName}.${[...(target.classList || [])].join('.')} ${how}`;
}

// ---------------------------------------------------------------- menu sheet

function openMenu() {
	closeDrawer();
	state.menuOpen = true;
	document.documentElement.classList.add('hd-menu-open');
	document.activeElement?.blur?.(); // no soft keyboard under the sheet
	renderMenuHead();
	render();
}

function closeMenu() {
	if (!state.menuOpen) return;
	state.menuOpen = false;
	document.documentElement.classList.remove('hd-menu-open');
	render();
}

function renderMenuHead() {
	const folder = document.getElementById('hd-menu-folder');
	if (folder) folder.textContent = state.folder?.name ?? '';
}

// ---------------------------------------------------------------- drawer

function openDrawer() {
	closeMenu();
	state.drawerOpen = true;
	document.documentElement.classList.add('hd-drawer-open');
	document.activeElement?.blur?.(); // no soft keyboard over the tree
	refreshState();
	render();
}

function closeDrawer() {
	if (!state.drawerOpen) return;
	state.drawerOpen = false;
	state.picker = null;
	document.documentElement.classList.remove('hd-drawer-open');
	render();
}

const samePath = (a, b) => !!a && !!b && (APPLE || !/^[a-z]:/i.test(a) ? a === b : a.toLowerCase() === b.toLowerCase());

async function toggleDir(path) {
	const node = state.tree.get(path);
	if (node) node.open = !node.open;
	else await loadDir(path, true);
	renderDrawer();
}

async function openFile(path) {
	if (!state.bridge) return toast('파일을 열려면 handide 확장이 필요합니다 (폴더 신뢰 확인).');
	closeDrawer();
	await bridgeCall('vscode.open', { $file: path });
	state.activePath = path;
	if (state.view !== 'editor' && state.view !== 'terminalDock') showView('editor');
}

async function openPicker(path) {
	const r = await api(`${BASE}fs?path=${encodeURIComponent(path ?? '')}`).catch(() => null);
	if (!r?.ok) return toast('폴더를 읽을 수 없습니다.');
	state.picker = { path: r.path, parent: r.parent, entries: r.entries.filter((e) => e.dir) };
	renderDrawer();
}

async function openFolder(path) {
	if (!state.bridge) return toast('폴더를 바꾸려면 handide 확장이 필요합니다.');
	toast('폴더를 여는 중… 페이지가 다시 로드됩니다.');
	await bridgeCall('vscode.openFolder', { $file: path }, { forceReuseWindow: true });
}

/**
 * Activates on a real tap (pointer up close to where it went down), not on the
 * browser's synthesized click: VS Code's own touch gesture handler can end up
 * suppressing clicks page-wide, and a scroll in the drawer must not open a file.
 * Keyboard activation (click with detail 0) still works.
 */
function onTap(node, fn) {
	let down = null;
	node.addEventListener('pointerdown', (e) => {
		down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
	});
	node.addEventListener('pointerup', (e) => {
		const d = down;
		down = null;
		if (!d || d.id !== e.pointerId || Date.now() - d.t > 700) return;
		if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
		e.preventDefault();
		fn(e);
	});
	node.addEventListener('pointercancel', () => (down = null));
	node.addEventListener('click', (e) => {
		if (e.detail === 0) fn(e); // keyboard; pointer taps were handled on pointerup
		e.preventDefault();
	});
}

function el(tag, attrs = {}, ...children) {
	const e = document.createElement(tag);
	for (const [key, v] of Object.entries(attrs)) {
		if (key === 'class') e.className = v;
		else if (key === 'onclick') onTap(e, v);
		else if (key.startsWith('on')) e.addEventListener(key.slice(2), v);
		else if (v !== false && v != null) e.setAttribute(key, v === true ? '' : v);
	}
	for (const c of children.flat()) if (c != null) e.append(c);
	return e;
}
const icon = (name) => el('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });

function renderDrawer() {
	const body = document.getElementById('hd-drawer-body');
	const head = document.getElementById('hd-drawer-head');
	if (!body || !head) return;
	head.replaceChildren();
	body.replaceChildren();

	if (state.picker) {
		const { path, parent, entries } = state.picker;
		head.append(
			el('div', { class: 'hd-drawer-title' }, el('strong', {}, '폴더 선택'), el('small', {}, path || '드라이브')),
			el('button', { class: 'hd-icon-btn', 'aria-label': '취소', onclick: () => ((state.picker = null), renderDrawer()) }, icon('close')),
		);
		if (parent !== null) body.append(row({ depth: 0, iconName: 'arrow-up', label: '상위 폴더', onclick: () => openPicker(parent) }));
		for (const e of entries) body.append(row({ depth: 0, iconName: 'folder', label: e.name, onclick: () => openPicker(e.path) }));
		if (!entries.length) body.append(el('p', { class: 'hd-empty' }, '하위 폴더가 없습니다.'));
		if (path) body.append(el('div', { class: 'hd-picker-actions' }, el('button', { class: 'hd-primary', onclick: () => openFolder(path) }, '이 폴더 열기')));
		return;
	}

	const folder = state.folder;
	head.append(
		el('div', { class: 'hd-drawer-title' }, el('strong', {}, folder?.name ?? '폴더 없음'), el('small', {}, folder?.path ?? '')),
		el('button', { class: 'hd-icon-btn', 'aria-label': '폴더 변경', title: '폴더 변경', onclick: () => openPicker(folder ? parentOf(folder.path) : '') }, icon('folder-opened')),
		el('button', { class: 'hd-icon-btn', 'aria-label': '새로고침', onclick: async () => { state.tree.clear(); if (folder) await loadDir(folder.path, true); renderDrawer(); } }, icon('refresh')),
		el('button', { class: 'hd-icon-btn', 'aria-label': '닫기', onclick: closeDrawer }, icon('close')),
	);
	if (!folder) {
		body.append(
			el('p', { class: 'hd-empty' }, state.bridge ? '열린 폴더가 없습니다.' : 'handide 확장을 기다리는 중입니다. 폴더를 신뢰했는지 확인하세요.'),
			el('div', { class: 'hd-picker-actions' }, el('button', { class: 'hd-primary', onclick: () => openPicker('') }, '폴더 열기')),
		);
		return;
	}
	const walk = (dir, depth) => {
		const node = state.tree.get(dir);
		if (!node?.open) return;
		for (const e of node.entries.slice(0, 500)) {
			const open = e.dir && state.tree.get(e.path)?.open;
			body.append(
				row({
					depth,
					iconName: e.dir ? (open ? 'chevron-down' : 'chevron-right') : 'file',
					label: e.name,
					dim: e.name.startsWith('.'),
					active: !e.dir && samePath(e.path, state.activePath),
					onclick: () => (e.dir ? toggleDir(e.path) : openFile(e.path)),
				}),
			);
			if (open) walk(e.path, depth + 1);
		}
		if (node.entries.length > 500) body.append(el('p', { class: 'hd-empty' }, `… ${node.entries.length - 500}개 더 있음`));
	};
	walk(folder.path, 0);
}

function parentOf(path) {
	const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
	if (i <= 0) return '';
	const p = path.slice(0, i);
	return /^[a-z]:$/i.test(p) ? `${p}\\` : p;
}

function row({ depth, iconName, label, onclick, dim, active }) {
	return el(
		'button',
		{ class: `hd-row${dim ? ' dim' : ''}${active ? ' active' : ''}`, style: `padding-left:${16 + depth * 14}px`, onclick },
		icon(iconName),
		el('span', { class: 'hd-row-label' }, label),
	);
}

// ---------------------------------------------------------------- gestures

// Left edge swipe opens the file drawer, right edge swipe the AI drawer; each closes by
// swiping back the way it came (the AI drawer on its bar or from the left edge), and
// the menu sheet and the terminal's grab bar close when swiped down. Touches that
// belong to the layer are kept from VS Code's own gesture handler: a swipe that starts
// on the editor and ends over a layer element would otherwise leave it thinking a
// finger is still down, and it then swallows every following tap.
function installGestures() {
	let start = null;
	const ours = (e) => !!e.target.closest?.('#hd-drawer, #hd-scrim, #hd-menu, #hd-menu-scrim, #hd-fab, #hd-viewbar');
	const edge = (z) => z === 'leftEdge' || z === 'rightEdge';
	const zoneOf = (e, t) => {
		if (e.touches.length !== 1) return null;
		const free = !state.drawerOpen && !state.menuOpen;
		if (free && t.clientX < 18) return 'leftEdge';
		if (free && t.clientX > document.documentElement.clientWidth - 18 && state.view !== 'ai') return 'rightEdge';
		if (state.drawerOpen && e.target.closest('#hd-drawer, #hd-scrim')) return 'drawer';
		if (state.menuOpen && e.target.closest('#hd-menu')) return 'menu';
		if (e.target.closest('#hd-viewbar')) return VIEW_BARS[state.view]?.side ?? null;
		return null;
	};
	document.addEventListener(
		'touchstart',
		(e) => {
			const t = e.touches[0];
			const zone = zoneOf(e, t);
			start = zone ? { x: t.clientX, y: t.clientY, zone } : null;
			if (edge(start?.zone) || ours(e)) e.stopPropagation();
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		'touchmove',
		(e) => {
			if (edge(start?.zone) || ours(e)) e.stopPropagation();
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		'touchend',
		(e) => {
			const s0 = start;
			start = null;
			if (edge(s0?.zone) || ours(e)) e.stopPropagation();
			if (!s0) return;
			const t = e.changedTouches[0];
			const dx = t.clientX - s0.x;
			const dy = t.clientY - s0.y;
			const sideways = Math.abs(dy) < 60;
			const downward = Math.abs(dx) < 80;
			if (s0.zone === 'leftEdge' && dx > 50 && sideways) state.view === 'ai' ? showView('editor') : openDrawer();
			else if (s0.zone === 'rightEdge' && dx < -50 && sideways) showView('ai');
			else if (s0.zone === 'drawer' && dx < -60 && sideways) closeDrawer();
			else if (s0.zone === 'menu' && dy > 60 && downward) closeMenu();
			else if (s0.zone === 'bottom' && dy > 40 && downward) showView('editor');
			else if (s0.zone === 'right' && dx > 50 && sideways) showView('editor');
		},
		{ passive: true, capture: true },
	);
}

// ---------------------------------------------------------------- floating button

const FAB_SIZE = 52;
const FAB_MARGIN = 12;

function loadFab() {
	try {
		const f = JSON.parse(localStorage.getItem('handide.fab'));
		if ((f?.side === 'left' || f?.side === 'right') && f.y >= 0 && f.y <= 1) return f;
	} catch {
		// unreadable: default position
	}
	return { side: 'right', y: 0.72 };
}

/** The band the button may sit in: between the top inset and our bottom bars. */
function fabBand() {
	const top = (vv?.offsetTop || 0) + reservedTop + FAB_MARGIN;
	let bottom = (vv?.offsetTop || 0) + realViewportHeight() - reservedBottom - FAB_SIZE - FAB_MARGIN;
	// Above the terminal drawer, off its grab bar.
	const bar = document.getElementById('hd-viewbar');
	if (VIEW_BARS[state.view]?.side === 'bottom' && bar && !bar.hidden) bottom = Math.min(bottom, bar.getBoundingClientRect().top - FAB_SIZE - FAB_MARGIN);
	return { top, bottom: Math.max(top, bottom), width: document.documentElement.clientWidth };
}

function placeFab() {
	const fab = document.getElementById('hd-fab');
	if (!fab || fab.dataset.dragging) return;
	const band = fabBand();
	fab.style.left = `${state.fab.side === 'left' ? FAB_MARGIN : band.width - FAB_SIZE - FAB_MARGIN}px`;
	fab.style.top = `${Math.round(band.top + state.fab.y * (band.bottom - band.top))}px`;
}

// Tap opens the menu; dragging moves the button, which then snaps to the nearest side.
function installFab(fab) {
	let down = null;
	fab.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		const r = fab.getBoundingClientRect();
		down = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, t: Date.now(), moved: false };
		fab.setPointerCapture?.(e.pointerId);
	});
	fab.addEventListener('pointermove', (e) => {
		if (!down || down.id !== e.pointerId) return;
		if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) return;
		down.moved = true;
		fab.dataset.dragging = '1';
		const band = fabBand();
		fab.style.left = `${Math.min(band.width - FAB_SIZE, Math.max(0, e.clientX - down.dx))}px`;
		fab.style.top = `${Math.min(band.bottom, Math.max(band.top, e.clientY - down.dy))}px`;
	});
	const end = (e) => {
		const d = down;
		down = null;
		if (!d || d.id !== e.pointerId) return;
		delete fab.dataset.dragging;
		if (!d.moved) {
			if (e.type === 'pointerup' && Date.now() - d.t < 700) openMenu();
			return;
		}
		const r = fab.getBoundingClientRect();
		const band = fabBand();
		state.fab = {
			side: r.left + r.width / 2 < band.width / 2 ? 'left' : 'right',
			y: band.bottom > band.top ? Math.min(1, Math.max(0, (r.top - band.top) / (band.bottom - band.top))) : 0,
		};
		localStorage.setItem('handide.fab', JSON.stringify(state.fab));
		placeFab();
	};
	fab.addEventListener('pointerup', end);
	fab.addEventListener('pointercancel', end);
	fab.addEventListener('click', (e) => {
		if (e.detail === 0) openMenu(); // keyboard
		e.preventDefault();
	});
}

// ---------------------------------------------------------------- view bar

// Laid exactly over the title strip of the part the view shows, so VS Code's desktop
// tabs and buttons there are covered by a phone header. Sized from the DOM only.
function renderViewbar() {
	const bar = document.getElementById('hd-viewbar');
	if (!bar || state.viewbarFor === state.view) return;
	state.viewbarFor = state.view;
	const def = VIEW_BARS[state.view];
	bar.replaceChildren();
	bar.classList.toggle('hd-grab', def?.side === 'bottom');
	if (!def) return;
	if (def.side === 'bottom') bar.append(el('span', { class: 'hd-grip', 'aria-hidden': 'true' }));
	bar.append(
		button({ class: 'hd-icon-btn', 'aria-label': '닫기', 'data-act': 'back' }, icon(def.side === 'bottom' ? 'chevron-down' : 'chevron-right'), () => showView('editor')),
		el('span', { class: 'hd-viewbar-title' }, def.title),
		...def.actions.map(([iconName, label, action]) => button({ class: 'hd-icon-btn', 'aria-label': label, 'data-act': action }, icon(iconName), () => runAction(action))),
	);
}

function placeViewbar() {
	const bar = document.getElementById('hd-viewbar');
	if (!bar) return;
	const def = VIEW_BARS[state.view];
	const title = def && visiblePart(def.part) ? document.querySelector(state.selectors.partTitles[def.part]) : null;
	const r = title?.getBoundingClientRect();
	if (!r || r.width < 8 || r.height < 8) {
		bar.hidden = true;
		return;
	}
	const moved = bar.hidden || bar.style.top !== `${r.top}px`;
	bar.hidden = false;
	bar.style.top = `${r.top}px`;
	bar.style.left = `${r.left}px`;
	bar.style.width = `${r.width}px`;
	bar.style.height = `${r.height}px`;
	if (moved && def.side === 'bottom') placeFab();
}

let toastTimer;
function toast(text) {
	const t = document.getElementById('hd-toast');
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

// ---------------------------------------------------------------- viewport

// VS Code sizes the workbench from window.innerHeight (visualViewport.height on
// iOS). Report the space between the top inset and our bottom bar, and push the
// workbench below the inset. Nothing inside VS Code is modified.
const vv = window.visualViewport;
const vvHeightDesc = vv && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height');
const realViewportHeight = () => (vvHeightDesc ? vvHeightDesc.get.call(vv) : document.documentElement.clientHeight);
let reservedTop = 0;
let reservedBottom = 0;

function installViewportShim() {
	const available = () => Math.max(200, Math.round(realViewportHeight() - reservedTop - reservedBottom));
	Object.defineProperty(window, 'innerHeight', { configurable: true, get: available });
	if (vv && vvHeightDesc) Object.defineProperty(vv, 'height', { configurable: true, get: available });
}

function relayout() {
	const root = document.getElementById('hd-root');
	const height = realViewportHeight();
	const offset = vv?.offsetTop || 0;
	// Keep the bottom bar glued to the visible area, even when the keyboard only
	// shrinks or pans the visual viewport (Android default, iOS).
	const rootH = root.getBoundingClientRect().height;
	root.style.top = `${Math.round(offset + height - rootH)}px`;
	reservedTop = document.getElementById('hd-safe').getBoundingClientRect().height;
	reservedBottom = rootH;
	const style = document.documentElement.style;
	style.setProperty('--hd-top', `${Math.round(offset + reservedTop)}px`);
	style.setProperty('--hd-bottom', `${Math.round(rootH)}px`);
	placeFab();
	window.dispatchEvent(new Event('resize'));
	requestAnimationFrame(placeViewbar);
}

function isTyping() {
	const a = document.activeElement;
	return !!a && a.matches?.(state.selectors.textInputs);
}

// Accessory keys follow the soft keyboard: a text input has focus *and* the visible
// area shrank. Focus alone is not enough: VS Code focuses the editor by itself, which
// raises no keyboard, and Android's back button hides the keyboard but keeps the focus.
// The keyboard-free height is the largest one seen at the current width.
let fullHeight = 0;
let fullHeightWidth = 0;
function updateKeys() {
	const h = realViewportHeight();
	const w = document.documentElement.clientWidth;
	if (w !== fullHeightWidth) {
		fullHeightWidth = w;
		fullHeight = 0;
	}
	fullHeight = Math.max(fullHeight, h);
	const on = isTyping() && h < fullHeight - 150;
	if (on === state.keysOn) return relayout();
	state.keysOn = on;
	render();
}

function onFocusIn(e) {
	if (e.target.matches?.(state.selectors.textInputs)) state.lastInput = e.target;
	updateKeys();
}

function onFocusOut() {
	setTimeout(updateKeys, 50);
}

// ---------------------------------------------------------------- UI

function button(attrs, children, onPress) {
	const b = el('button', { type: 'button', tabindex: '-1', ...attrs }, children);
	// Keep focus (and the soft keyboard) on the editor when tapping our bars.
	b.addEventListener('pointerdown', (e) => e.preventDefault());
	b.addEventListener('mousedown', (e) => e.preventDefault());
	onTap(b, () => onPress());
	return b;
}

function build() {
	const keys = el('div', { id: 'hd-keys' });
	for (const name of ['menu', ...state.config.accessoryKeys.filter((n) => n !== 'menu')]) {
		const def = KEY_DEFS[name];
		if (!def) continue;
		keys.append(button({ 'data-key': name, 'aria-label': name }, def.label && !def.icon ? def.label : icon(def.icon), () => pressKey(name, def)));
	}
	keys.append(button({ 'data-key': 'hideKeyboard', 'aria-label': '키보드 내리기' }, icon('chevron-down'), () => document.activeElement?.blur?.()));

	const insecure = el('div', { id: 'hd-insecure', hidden: window.isSecureContext }, 'HTTPS나 localhost로 접속해야 VS Code가 연결됩니다 (현재 http). PC에서 handide가 띄운 QR이나 링크로 여세요.');
	const notice = el('div', { id: 'hd-notice', hidden: true });
	const root = el('div', { id: 'hd-root' }, insecure, notice, keys);

	const fab = el('button', { id: 'hd-fab', type: 'button', tabindex: '-1', 'aria-label': '메뉴' }, icon('menu'));
	installFab(fab);

	const tiles = el('div', { id: 'hd-menu-grid' });
	for (const name of state.config.menu) {
		const def = MENU_DEFS[name];
		if (!def) continue;
		tiles.append(button({ class: 'hd-tile', 'data-item': name, 'aria-label': def.label }, [icon(def.icon), el('span', {}, def.label)], () => pressMenu(name)));
	}
	const menu = el(
		'section',
		{ id: 'hd-menu', 'aria-label': '메뉴' },
		el('span', { class: 'hd-grip', 'aria-hidden': 'true' }),
		el(
			'div',
			{ id: 'hd-menu-head' },
			button({ id: 'hd-title', 'aria-label': '파일 빠른 열기' }, [el('span', { id: 'hd-title-text' }, 'handide'), el('small', { id: 'hd-menu-folder' })], () => {
				closeMenu();
				runAction('quickOpen');
			}),
			button({ class: 'hd-icon-btn', 'aria-label': '저장', 'data-act': 'save' }, icon('save'), () => runAction('save')),
			button({ class: 'hd-icon-btn', 'aria-label': '닫기', 'data-act': 'close' }, icon('close'), closeMenu),
		),
		tiles,
	);
	const menuScrim = el('div', { id: 'hd-menu-scrim', onclick: closeMenu });

	const drawer = el(
		'aside',
		{ id: 'hd-drawer', 'aria-label': '파일' },
		el('div', { id: 'hd-drawer-head' }),
		el('div', { id: 'hd-drawer-body' }),
	);
	const scrim = el('div', { id: 'hd-scrim', onclick: closeDrawer });

	const viewbar = el('div', { id: 'hd-viewbar', hidden: true });

	const sheet = el(
		'form',
		{ id: 'hd-sheet', hidden: true },
		el('textarea', { rows: '4', placeholder: '여기에 입력 (한글 OK) → 삽입', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' }),
		el(
			'div',
			{ class: 'hd-sheet-actions' },
			el('button', { type: 'button', 'data-act': 'cancel', onclick: closeInputSheet }, '취소'),
			el('button', { type: 'submit' }, '삽입'),
		),
	);
	// Tapping the buttons must not take the focus (and the keyboard) from the text box.
	for (const b of sheet.querySelectorAll('button')) b.addEventListener('pointerdown', (e) => e.preventDefault());
	const toastEl = el('div', { id: 'hd-toast', hidden: true, role: 'status' });
	const safe = el('div', { id: 'hd-safe', 'aria-hidden': 'true' });

	document.body.append(safe, viewbar, root, fab, menuScrim, menu, scrim, drawer, sheet, toastEl);
	renderDrawer();
}

function pressKey(name, def) {
	if (def.menu) return openMenu();
	if (def.sticky) {
		state.sticky[def.sticky] = !state.sticky[def.sticky];
		render();
		return;
	}
	if (def.input) return openInputSheet();
	if (def.action) return runAction(def.action);
	sendKey({ key: def.key, keyCode: def.keyCode, ...consumeSticky() });
}

function render() {
	const root = document.getElementById('hd-root');
	if (!root) return;
	const sheetOpen = !document.getElementById('hd-sheet').hidden;
	root.dataset.keys = state.keysOn && !sheetOpen ? '1' : '';
	document.documentElement.dataset.hdView = state.view;
	document.getElementById('hd-fab').hidden = state.keysOn || state.drawerOpen || state.menuOpen || sheetOpen;
	for (const b of document.querySelectorAll('#hd-menu [data-item]')) b.classList.toggle('active', MENU_DEFS[b.dataset.item]?.view === state.view);
	for (const b of root.querySelectorAll('[data-key]')) {
		const def = KEY_DEFS[b.dataset.key];
		b.classList.toggle('active', !!(def?.sticky && state.sticky[def.sticky]));
	}
	renderViewbar();
	requestAnimationFrame(relayout);
}

// The active file, from VS Code's own window title ("● name - folder - …"):
// shown in the menu sheet, and as a dot on the floating button while unsaved.
function watchTitle() {
	const update = () => {
		const [first] = document.title.split(' - ');
		const dirty = first.startsWith('●');
		const name = first.replace(/^●\s*/, '').trim();
		const known = name && !/Visual Studio Code/.test(name);
		const text = document.getElementById('hd-title-text');
		text.textContent = known ? name : state.folder?.name ?? 'handide';
		text.classList.toggle('dirty', dirty);
		document.getElementById('hd-fab').classList.toggle('dirty', dirty);
	};
	new MutationObserver(update).observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true });
	update();
}

// VS Code defines its theme variables on the workbench element, and our UI lives
// outside it. Copy the few we use onto our elements, and again whenever the theme changes.
const THEME_VARS = [
	'--vscode-sideBar-background', '--vscode-editor-background', '--vscode-foreground',
	'--vscode-descriptionForeground', '--vscode-focusBorder', '--vscode-panel-border',
	'--vscode-panel-background', '--vscode-sideBarSectionHeader-background',
	'--vscode-button-background', '--vscode-button-foreground',
	'--vscode-button-secondaryBackground', '--vscode-button-secondaryForeground',
	'--vscode-input-background', '--vscode-input-foreground',
	'--vscode-list-activeSelectionBackground', '--vscode-list-activeSelectionForeground', '--vscode-list-hoverBackground',
	'--vscode-titleBar-activeBackground', '--vscode-titleBar-activeForeground',
	'--vscode-inputValidation-warningBackground', '--vscode-inputValidation-warningForeground',
	'--vscode-inputValidation-errorBackground', '--vscode-inputValidation-errorForeground',
	'--vscode-widget-shadow',
	'--vscode-font-family', '--vscode-editor-font-family',
];

function syncTheme(workbench) {
	const copy = () => {
		const computed = getComputedStyle(workbench);
		const style = document.documentElement.style;
		for (const name of THEME_VARS) {
			const value = computed.getPropertyValue(name);
			if (value) style.setProperty(name, value);
		}
		const bg = computed.getPropertyValue('--vscode-editor-background');
		if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg.trim());
	};
	new MutationObserver(copy).observe(workbench, { attributes: true, attributeFilter: ['class'] });
	copy();
	setTimeout(copy, 2000);
}

// Restricted Mode disables the companion extension: bridge, views and file opening stop.
function watchTrust() {
	const notice = document.getElementById('hd-notice');
	const update = () => {
		const banner = document.querySelector(state.selectors.banner);
		const restricted = !!banner && banner.getBoundingClientRect().height > 0 && /Restricted Mode/i.test(banner.textContent);
		if (restricted === !notice.hidden) return;
		notice.hidden = !restricted;
		if (restricted) {
			notice.replaceChildren(
				el('span', {}, '이 폴더를 신뢰해야 화면 전환, 파일 열기, 에이전트 확장이 동작합니다.'),
				button({}, '신뢰 설정', () => [...banner.querySelectorAll('a')].find((a) => /Manage/i.test(a.textContent))?.click()),
			);
		}
		requestAnimationFrame(relayout);
	};
	let queued = false;
	new MutationObserver((records) => {
		if (queued || records.every((r) => r.target.closest?.('#hd-viewbar, #hd-fab'))) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			update();
			syncViewFromLayout();
			placeViewbar();
		});
	}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
	update();
}

// ---------------------------------------------------------------- boot

async function loadJson(name) {
	const res = await fetch(BASE + name, { cache: 'no-cache' });
	return res.json();
}

function waitFor(selector) {
	return new Promise((resolve) => {
		const found = document.querySelector(selector);
		if (found) return resolve(found);
		const obs = new MutationObserver(() => {
			const e = document.querySelector(selector);
			if (e) {
				obs.disconnect();
				resolve(e);
			}
		});
		obs.observe(document.documentElement, { childList: true, subtree: true });
	});
}

async function main() {
	const [config, commands, selectors] = await Promise.all([loadJson('config.json'), loadJson('commands.json'), loadJson('selectors.json')]);
	config.menu ??= DEFAULT_MENU;
	config.accessoryKeys ??= ['esc', 'tab', 'ctrl', 'left', 'up', 'down', 'right', 'undo', 'input'];
	Object.assign(state, { config, commands, selectors });

	const mobile = window.matchMedia(`(max-width: ${config.breakpoint}px), (pointer: coarse)`);
	if (!mobile.matches) return; // desktop browsers get plain VS Code

	document.documentElement.classList.add('hd-mobile');
	installViewportShim();
	build();
	render();
	installGestures();

	updateKeys();
	vv?.addEventListener('resize', updateKeys);
	vv?.addEventListener('scroll', relayout);
	window.addEventListener('orientationchange', () => setTimeout(updateKeys, 300));
	document.addEventListener('focusin', onFocusIn);
	document.addEventListener('focusout', onFocusOut);
	document.addEventListener('beforeinput', onBeforeInput, true);
	document.addEventListener(
		'keydown',
		(e) => {
			if (e.key !== 'Escape') return;
			if (state.menuOpen) closeMenu();
			else if (state.drawerOpen) closeDrawer();
		},
		true,
	);

	syncTheme(await waitFor(selectors.workbench));
	watchTrust();
	watchTitle();
	state.folder = pageFolder();
	renderMenuHead();
	if (state.folder) loadDir(state.folder.path, true).then(renderDrawer);
	if (!builtin() && (await waitForBridge())) {
		await refreshState();
		showView('editor');
		// Keep the drawer's active file and folder current.
		setInterval(() => state.drawerOpen || refreshState(), 5000);
	} else {
		setTimeout(() => showView('editor'), 2500);
	}
}

main().catch((err) => console.error('[handide] layer failed', err));
