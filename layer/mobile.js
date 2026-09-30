// handide mobile layer. Injected by the proxy into the real VS Code web UI.
//
// A mobile IDE shell around VS Code's own editor, terminal and chat:
//
//   ┌ app bar ─ ☰ · file name (quick open) · search · command palette ┐
//   │ editor (VS Code)                                                │
//   │ terminal docked below, or full screen (VS Code panel)           │
//   ├ accessory keys (while typing)                                   ┤
//   └ dock ─ Files · Code · Terminal · AI · Git                       ┘
//   Files = the layer's own drawer (file tree + folder picker) over the editor.
//
// It never touches VS Code internals. It talks to VS Code through
//  - the command bridge (proxy ↔ companion extension): official commands with
//    arguments, e.g. vscode.open / vscode.openFolder / handide.view,
//  - key chords bound by the companion extension (fallback when the bridge is down),
//  - the DOM only to read layout state (selectors.json) and to insert text.
const BASE = '/__handide/';

const KEY_DEFS = {
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

// Dock buttons. `files` opens the drawer; the rest are views.
const DOCK_DEFS = {
	files: { icon: 'files', label: '파일' },
	code: { icon: 'code', label: '코드', view: 'editor' },
	terminal: { icon: 'terminal', label: '터미널' },
	ai: { icon: 'sparkle', label: 'AI', view: 'ai' },
	git: { icon: 'source-control', label: 'Git', view: 'git' },
	search: { icon: 'search', label: '검색', view: 'search' },
};

// What each view looks like, as the set of VS Code parts that must be visible.
const VIEW_PARTS = {
	editor: ['editor'],
	terminalDock: ['editor', 'panel'],
	terminal: ['panel'],
	search: ['panel'],
	git: ['panel'],
	ai: ['auxiliarybar'],
};
// Views where the user types: the accessory key row shows there.
const TYPING_VIEWS = new Set(['editor', 'terminalDock', 'terminal', 'ai']);

const state = {
	config: null,
	commands: null,
	selectors: null,
	view: 'editor',
	sticky: { ctrlKey: false, altKey: false, shiftKey: false },
	keyboardOpen: false,
	lastInput: null,
	bridge: false,
	folder: null, // { name, path }
	activePath: null,
	tree: new Map(), // dir path → { entries, open }
	picker: null, // { path, parent, entries } while choosing a folder
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

function focusTarget() {
	const active = document.activeElement;
	if (active && active !== document.body && !active.closest('#hd-root, #hd-appbar, #hd-drawer')) return active;
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
	search: k('F', 'KeyF', 70, { ...MOD, shiftKey: true }),
	git: k('G', 'KeyG', 71, { ctrlKey: true, shiftKey: true }),
	terminal: k('`', 'Backquote', 192, { ctrlKey: true }),
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
	else chord(action.key);
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
	render();
	if (builtin()) {
		// Ctrl+` toggles the terminal: pressing it again while it is open would close it.
		const terminalAlreadyOpen = (view === 'terminal' || view === 'terminalDock') && visiblePart('panel');
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

/** Keeps the dock in sync when VS Code's own buttons change the layout (e.g. panel ✕). */
function syncViewFromLayout() {
	if (Date.now() < (state.settlingUntil || 0)) return;
	const shown = visibleParts();
	let view = state.view;
	if (state.view === 'terminalDock' && !shown.includes('panel')) view = 'editor';
	if (state.view === 'terminalDock' && shown.includes('panel') && !shown.includes('editor')) view = 'terminal';
	if (state.view === 'terminal' && shown.includes('editor') && shown.includes('panel')) view = 'terminalDock';
	if ((state.view === 'terminal' || state.view === 'search' || state.view === 'git') && !shown.includes('panel') && shown.includes('editor')) view = 'editor';
	if (state.view === 'ai' && !shown.includes('auxiliarybar') && shown.includes('editor')) view = 'editor';
	if (view !== state.view) {
		state.view = view;
		render();
	}
}

function pressDock(name) {
	if (name === 'files') return state.drawerOpen ? closeDrawer() : openDrawer();
	if (name === 'terminal') {
		// Editor → terminal docked below → terminal full screen → docked again.
		return showView(state.view === 'terminalDock' ? 'terminal' : 'terminalDock');
	}
	showView(DOCK_DEFS[name].view);
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
	sheet.onsubmit = (e) => {
		e.preventDefault();
		sheet.hidden = true;
		if (area.value) pasteInto(target, area.value);
	};
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

// ---------------------------------------------------------------- drawer

function openDrawer() {
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
		{ class: `hd-row${dim ? ' dim' : ''}${active ? ' active' : ''}`, style: `padding-left:${12 + depth * 14}px`, onclick },
		icon(iconName),
		el('span', { class: 'hd-row-label' }, label),
	);
}

// Edge swipe opens the drawer; swiping it left closes it. Touches that belong to
// the layer (edge swipe, anything in the drawer or on the scrim) are kept from VS
// Code's own gesture handler: a swipe that starts on the editor and ends over the
// drawer would otherwise leave it thinking a finger is still down, and it then
// swallows every following tap.
function installGestures() {
	let start = null;
	const ours = (e) => !!e.target.closest?.('#hd-drawer, #hd-scrim');
	document.addEventListener(
		'touchstart',
		(e) => {
			const t = e.touches[0];
			if (e.touches.length === 1 && !state.drawerOpen && t.clientX < 18) start = { x: t.clientX, y: t.clientY, edge: true };
			else if (e.touches.length === 1 && state.drawerOpen && ours(e)) start = { x: t.clientX, y: t.clientY, edge: false };
			else start = null;
			if (start?.edge || ours(e)) e.stopPropagation();
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		'touchmove',
		(e) => {
			if (start?.edge || ours(e)) e.stopPropagation();
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		'touchend',
		(e) => {
			const s0 = start;
			start = null;
			if (s0?.edge || ours(e)) e.stopPropagation();
			if (!s0) return;
			const t = e.changedTouches[0];
			const dx = t.clientX - s0.x;
			const dy = Math.abs(t.clientY - s0.y);
			if (!state.drawerOpen && dx > 50 && dy < 60) openDrawer();
			else if (state.drawerOpen && dx < -60 && dy < 60) closeDrawer();
		},
		{ passive: true, capture: true },
	);
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
// iOS). Report the space between our app bar and our bottom bars, and push the
// workbench below the app bar. Nothing inside VS Code is modified.
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
	const bar = document.getElementById('hd-appbar');
	const height = realViewportHeight();
	const offset = vv?.offsetTop || 0;
	state.keyboardOpen = height < screen.height * 0.6 && isTyping();
	root.dataset.keyboard = state.keyboardOpen ? '1' : '';
	// Keep both bars glued to the visible area, even when the keyboard only shrinks
	// or pans the visual viewport (Android default, iOS).
	bar.style.top = `${Math.round(offset)}px`;
	const barH = bar.getBoundingClientRect().height;
	const rootH = root.getBoundingClientRect().height;
	root.style.top = `${Math.round(offset + height - rootH)}px`;
	reservedTop = barH;
	reservedBottom = rootH;
	document.documentElement.style.setProperty('--hd-top', `${Math.round(offset + barH)}px`);
	window.dispatchEvent(new Event('resize'));
}

function isTyping() {
	const a = document.activeElement;
	return !!a && a.matches?.(state.selectors.textInputs);
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
	const appbar = el(
		'header',
		{ id: 'hd-appbar' },
		button({ class: 'hd-icon-btn', 'aria-label': '파일', 'data-act': 'drawer' }, icon('menu'), () => (state.drawerOpen ? closeDrawer() : openDrawer())),
		button({ id: 'hd-title', 'aria-label': '파일 빠른 열기' }, [el('span', { id: 'hd-title-text' }, 'handide'), icon('chevron-down')], () => runAction('quickOpen')),
		button({ class: 'hd-icon-btn', 'aria-label': '검색', 'data-act': 'search' }, icon('search'), () => showView(state.view === 'search' ? 'editor' : 'search')),
		button({ class: 'hd-icon-btn', 'aria-label': '명령 팔레트', 'data-act': 'palette' }, icon('kebab-vertical'), () => runAction('commandPalette')),
	);

	const keys = el('div', { id: 'hd-keys' });
	for (const name of state.config.accessoryKeys) {
		const def = KEY_DEFS[name];
		if (!def) continue;
		keys.append(button({ 'data-key': name, 'aria-label': name }, def.label && !def.icon ? def.label : icon(def.icon), () => pressKey(name, def)));
	}
	// Shown only while the soft keyboard is up.
	keys.append(button({ 'data-key': 'hideKeyboard', 'aria-label': '키보드 내리기', class: 'hd-kb-only' }, icon('chevron-down'), () => document.activeElement?.blur?.()));

	const dock = el('nav', { id: 'hd-dock' });
	for (const name of state.config.dock) {
		const def = DOCK_DEFS[name];
		if (!def) continue;
		dock.append(button({ 'data-dock': name, 'aria-label': def.label }, [icon(def.icon), el('span', {}, def.label)], () => pressDock(name)));
	}

	const insecure = el('div', { id: 'hd-insecure', hidden: window.isSecureContext }, 'HTTPS나 localhost로 접속해야 VS Code가 연결됩니다 (현재 http). PC에서 npm start가 띄운 QR이나 링크로 여세요.');
	const notice = el('div', { id: 'hd-notice', hidden: true });
	const root = el('div', { id: 'hd-root' }, insecure, notice, keys, dock);

	const drawer = el(
		'aside',
		{ id: 'hd-drawer', 'aria-label': '파일' },
		el('div', { id: 'hd-drawer-head' }),
		el('div', { id: 'hd-drawer-body' }),
	);
	const scrim = el('div', { id: 'hd-scrim', onclick: closeDrawer });

	const sheet = el(
		'form',
		{ id: 'hd-sheet', hidden: true },
		el('textarea', { rows: '4', placeholder: '여기에 입력 (한글 OK) → 삽입', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' }),
		el(
			'div',
			{ class: 'hd-sheet-actions' },
			el('button', { type: 'button', 'data-act': 'cancel', onclick: () => (document.getElementById('hd-sheet').hidden = true) }, '취소'),
			el('button', { type: 'submit' }, '삽입'),
		),
	);
	const toastEl = el('div', { id: 'hd-toast', hidden: true, role: 'status' });

	document.body.append(appbar, root, scrim, drawer, sheet, toastEl);
	renderDrawer();
}

function pressKey(name, def) {
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
	root.dataset.view = state.view;
	root.dataset.typing = TYPING_VIEWS.has(state.view) ? '1' : '';
	const dockActive = { editor: 'code', terminalDock: 'terminal', terminal: 'terminal', ai: 'ai', git: 'git', search: 'search' }[state.view];
	for (const b of root.querySelectorAll('[data-dock]')) {
		b.classList.toggle('active', b.dataset.dock === (state.drawerOpen ? 'files' : dockActive));
		if (b.dataset.dock === 'terminal') b.dataset.mode = state.view === 'terminal' ? 'full' : state.view === 'terminalDock' ? 'dock' : '';
	}
	document.querySelector('#hd-appbar [data-act="search"]')?.classList.toggle('active', state.view === 'search');
	for (const b of root.querySelectorAll('[data-key]')) {
		const def = KEY_DEFS[b.dataset.key];
		b.classList.toggle('active', !!(def?.sticky && state.sticky[def.sticky]));
	}
	requestAnimationFrame(relayout);
}

// App bar title = the active file, from VS Code's own window title ("● name - folder - …").
function watchTitle() {
	const update = () => {
		const [first] = document.title.split(' - ');
		const dirty = first.startsWith('●');
		const name = first.replace(/^●\s*/, '').trim();
		const known = name && !/Visual Studio Code/.test(name);
		const text = document.getElementById('hd-title-text');
		text.textContent = known ? name : state.folder?.name ?? 'handide';
		text.classList.toggle('dirty', dirty);
	};
	new MutationObserver(update).observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true });
	update();
}

// VS Code defines its theme variables on the workbench element, and our UI lives
// outside it. Copy the few we use onto our elements, and again whenever the theme changes.
const THEME_VARS = [
	'--vscode-sideBar-background', '--vscode-editor-background', '--vscode-foreground',
	'--vscode-descriptionForeground', '--vscode-focusBorder', '--vscode-panel-border',
	'--vscode-button-background', '--vscode-button-foreground',
	'--vscode-button-secondaryBackground', '--vscode-button-secondaryForeground',
	'--vscode-input-background', '--vscode-input-foreground',
	'--vscode-list-activeSelectionBackground', '--vscode-list-activeSelectionForeground', '--vscode-list-hoverBackground',
	'--vscode-titleBar-activeBackground', '--vscode-titleBar-activeForeground',
	'--vscode-inputValidation-warningBackground', '--vscode-inputValidation-warningForeground',
	'--vscode-inputValidation-errorBackground', '--vscode-inputValidation-errorForeground',
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
		const bg = computed.getPropertyValue('--vscode-sideBar-background') || computed.getPropertyValue('--vscode-editor-background');
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
				el('span', {}, '이 폴더를 신뢰해야 모바일 화면 전환, 파일 열기, 에이전트 확장이 동작합니다.'),
				button({}, '신뢰 설정', () => [...banner.querySelectorAll('a')].find((a) => /Manage/i.test(a.textContent))?.click()),
			);
		}
		requestAnimationFrame(relayout);
	};
	let queued = false;
	new MutationObserver(() => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			update();
			syncViewFromLayout();
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
	config.dock ??= ['files', 'code', 'terminal', 'ai', 'git'];
	Object.assign(state, { config, commands, selectors });

	const mobile = window.matchMedia(`(max-width: ${config.breakpoint}px), (pointer: coarse)`);
	if (!mobile.matches) return; // desktop browsers get plain VS Code

	document.documentElement.classList.add('hd-mobile');
	installViewportShim();
	build();
	render();
	installGestures();

	vv?.addEventListener('resize', relayout);
	vv?.addEventListener('scroll', relayout);
	document.addEventListener('focusin', (e) => {
		if (e.target.matches?.(selectors.textInputs)) state.lastInput = e.target;
		requestAnimationFrame(relayout);
	});
	document.addEventListener('focusout', () => requestAnimationFrame(relayout));
	document.addEventListener('beforeinput', onBeforeInput, true);
	document.addEventListener('keydown', (e) => e.key === 'Escape' && state.drawerOpen && closeDrawer(), true);

	syncTheme(await waitFor(selectors.workbench));
	watchTrust();
	watchTitle();
	state.folder = pageFolder();
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
