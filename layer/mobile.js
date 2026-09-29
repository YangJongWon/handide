// handide mobile layer. Injected by the proxy into the real VS Code web UI.
//
// It never calls VS Code internals. It only:
//  - draws its own bottom bars (tabs + accessory keys) outside the workbench,
//  - shrinks the height VS Code sees so the workbench sits above those bars,
//  - sends key chords that the companion extension binds to official commands,
//  - pastes text from a native input sheet (reliable IME, including Korean).
const BASE = '/__handide/';

const TAB_DEFS = {
	code: { icon: 'code', label: 'Code' },
	files: { icon: 'files', label: 'Files' },
	search: { icon: 'search', label: 'Search' },
	git: { icon: 'source-control', label: 'Git' },
	terminal: { icon: 'terminal', label: 'Term' },
	chat: { icon: 'comment-discussion', label: 'Chat' },
};

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
	palette: { icon: 'terminal-cmd', label: '⌘', action: 'commandPalette' },
	input: { icon: 'edit', label: '가', input: true },
};

// Tabs where the user types; the accessory key row is shown there.
const TYPING_TABS = new Set(['code', 'terminal', 'chat']);

const state = {
	config: null,
	commands: null,
	selectors: null,
	tab: 'code',
	sticky: { ctrlKey: false, altKey: false, shiftKey: false },
	keyboardOpen: false,
	lastInput: null,
};

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
	if (active && active !== document.body && !active.closest('#hd-root')) return active;
	if (state.lastInput?.isConnected) return state.lastInput;
	return document.querySelector(state.selectors.workbench) || document.body;
}

function chord(key) {
	const [ctrl, alt, shift] = ['ctrl', 'alt', 'shift'].map((m) => state.commands.modifiers.includes(m));
	sendKey({ key, ctrlKey: ctrl, altKey: alt, shiftKey: shift });
}

function runAction(name) {
	if (state.config.companion?.mode === 'builtin') {
		if (BUILTIN_ACTIONS[name]) sendKey(BUILTIN_ACTIONS[name]);
		return;
	}
	const action = state.commands.actions[name];
	if (action) chord(action.key);
}

// Fallback when the companion extension can't be used (layer.config.json
// companion.mode = "builtin"): VS Code's own default shortcuts. Each area opens,
// but without the one-full-screen-area-per-tab layout.
const APPLE = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
const k = (key, code, keyCode, mods) => ({ key, code, keyCode, ...mods });
const BUILTIN_TABS = APPLE
	? {
			code: k('1', 'Digit1', 49, { metaKey: true }),
			files: k('E', 'KeyE', 69, { metaKey: true, shiftKey: true }),
			search: k('F', 'KeyF', 70, { metaKey: true, shiftKey: true }),
			git: k('G', 'KeyG', 71, { ctrlKey: true, shiftKey: true }),
			terminal: k('`', 'Backquote', 192, { ctrlKey: true }),
			chat: k('I', 'KeyI', 73, { ctrlKey: true, metaKey: true }),
		}
	: {
			code: k('1', 'Digit1', 49, { ctrlKey: true }),
			files: k('E', 'KeyE', 69, { ctrlKey: true, shiftKey: true }),
			search: k('F', 'KeyF', 70, { ctrlKey: true, shiftKey: true }),
			git: k('G', 'KeyG', 71, { ctrlKey: true, shiftKey: true }),
			terminal: k('`', 'Backquote', 192, { ctrlKey: true }),
			chat: k('I', 'KeyI', 73, { ctrlKey: true, altKey: true }),
		};

const MOD = APPLE ? { metaKey: true } : { ctrlKey: true };
const BUILTIN_ACTIONS = {
	quickOpen: k('P', 'KeyP', 80, MOD),
	commandPalette: k('P', 'KeyP', 80, { ...MOD, shiftKey: true }),
	save: k('S', 'KeyS', 83, MOD),
	undo: k('Z', 'KeyZ', 90, MOD),
	redo: APPLE ? k('Z', 'KeyZ', 90, { metaKey: true, shiftKey: true }) : k('Y', 'KeyY', 89, { ctrlKey: true }),
	find: k('F', 'KeyF', 70, MOD),
};

function showTab(tab) {
	const key = state.commands.tabs[tab];
	if (!key) return;
	state.tab = tab;
	if (state.config.companion?.mode === 'builtin') {
		if (BUILTIN_TABS[tab]) sendKey(BUILTIN_TABS[tab]);
	} else {
		chord(key);
		settleTab(tab, key);
	}
	render();
	// VS Code focuses the new area asynchronously; refocus text input for typing tabs.
	if (tab === 'code') setTimeout(() => focusTarget().focus?.(), 150);
}

// The extension opens the right area with idempotent commands. Making it fill the
// screen needs "maximize panel", a toggle whose state only the DOM reveals, so the
// layer finishes the job: it watches the result and toggles only when the panel is
// open but still sharing the screen. Also resends the tab once if nothing happened.
const TAB_PART = { code: 'editor', files: 'panel', search: 'panel', git: 'panel', terminal: 'panel', chat: 'auxiliarybar' };

function visiblePart(name) {
	const el = document.querySelector(state.selectors.parts[name]);
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
}

function settleTab(tab, key) {
	const want = TAB_PART[tab];
	if (!want) return;
	const started = Date.now();
	let resent = false;
	let toggledAt = 0;
	let layoutAtToggle = '';
	const layout = () => Object.keys(state.selectors.parts).filter(visiblePart).join(',');
	const tick = () => {
		if (state.tab !== tab || Date.now() - started > 4000) return; // user moved on, or give up
		const shown = layout();
		const extra = shown.split(',').filter((p) => p && p !== want);
		if (visiblePart(want) && extra.length === 0) return; // done
		if (want === 'panel' && visiblePart('panel')) {
			// Toggle once, then only again after the layout visibly changed (never undo our own toggle).
			if (!toggledAt || (shown !== layoutAtToggle && Date.now() - toggledAt > 600)) {
				toggledAt = Date.now();
				layoutAtToggle = shown;
				runAction('toggleMaximizedPanel');
			}
		} else if (!resent && Date.now() - started > 1200) {
			resent = true;
			chord(key);
		}
		setTimeout(tick, 300);
	};
	setTimeout(tick, 300);
}

// ---------------------------------------------------------------- sticky modifiers

function consumeSticky() {
	const mods = { ...state.sticky };
	state.sticky = { ctrlKey: false, altKey: false, shiftKey: false };
	render();
	return mods;
}

function anySticky() {
	return state.sticky.ctrlKey || state.sticky.altKey || state.sticky.shiftKey;
}

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
	sheet.dataset.open = '1';
	area.value = '';
	area.focus();
	sheet.onsubmit = (e) => {
		e.preventDefault();
		closeInputSheet();
		if (area.value) pasteInto(target, area.value);
	};
}

function closeInputSheet() {
	const sheet = document.getElementById('hd-sheet');
	sheet.hidden = true;
	delete sheet.dataset.open;
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

// ---------------------------------------------------------------- viewport

// VS Code sizes the workbench from window.innerHeight (visualViewport.height on
// iOS). Report a smaller value so the workbench ends above our bars and above the
// on-screen keyboard. Nothing inside VS Code is modified.
const vv = window.visualViewport;
const vvHeightDesc = vv && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height');
const realViewportHeight = () => (vvHeightDesc ? vvHeightDesc.get.call(vv) : document.documentElement.clientHeight);
let reserved = 0;

function installViewportShim() {
	const available = () => Math.max(200, Math.round(realViewportHeight() - reserved));
	Object.defineProperty(window, 'innerHeight', { configurable: true, get: available });
	if (vv && vvHeightDesc) Object.defineProperty(vv, 'height', { configurable: true, get: available });
}

function relayout() {
	const root = document.getElementById('hd-root');
	const height = realViewportHeight();
	state.keyboardOpen = height < screen.height * 0.6 && isTyping();
	root.dataset.keyboard = state.keyboardOpen ? '1' : '';
	const barHeight = root.getBoundingClientRect().height;
	// Keep the bars glued to the visible bottom, even when the keyboard only
	// shrinks the visual viewport (Android default, iOS).
	root.style.top = `${Math.round((vv?.offsetTop || 0) + height - barHeight)}px`;
	if (Math.abs(barHeight - reserved) > 0.5) {
		reserved = barHeight;
	}
	window.dispatchEvent(new Event('resize'));
}

function isTyping() {
	const el = document.activeElement;
	return !!el && el.matches?.(state.selectors.textInputs);
}

// ---------------------------------------------------------------- UI

const icon = (name) => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;

function button(attrs, html, onPress) {
	const b = document.createElement('button');
	b.type = 'button';
	b.tabIndex = -1;
	for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
	b.innerHTML = html;
	// Keep focus (and the soft keyboard) on the editor when tapping our bars.
	b.addEventListener('pointerdown', (e) => e.preventDefault());
	b.addEventListener('mousedown', (e) => e.preventDefault());
	b.addEventListener('click', (e) => {
		e.preventDefault();
		onPress();
	});
	return b;
}

function build() {
	const root = document.createElement('div');
	root.id = 'hd-root';

	const keys = document.createElement('div');
	keys.id = 'hd-keys';
	for (const name of state.config.accessoryKeys) {
		const def = KEY_DEFS[name];
		if (!def) continue;
		const html = def.label && !def.icon ? def.label : def.label && def.input ? def.label : icon(def.icon);
		keys.append(button({ 'data-key': name, 'aria-label': name }, html, () => pressKey(name, def)));
	}
	// Shown only while the soft keyboard is up: closing it brings the full tab bar back.
	const hide = button({ 'data-key': 'hideKeyboard', 'aria-label': 'hide keyboard', class: 'hd-kb-only' }, icon('chevron-down'), () => {
		document.activeElement?.blur?.();
	});
	keys.append(hide);

	const tabs = document.createElement('nav');
	tabs.id = 'hd-tabs';
	for (const name of state.config.tabs) {
		const def = TAB_DEFS[name];
		if (!def) continue;
		tabs.append(button({ 'data-tab': name, 'aria-label': def.label }, `${icon(def.icon)}<span>${def.label}</span>`, () => showTab(name)));
	}

	const notice = document.createElement('div');
	notice.id = 'hd-notice';
	notice.hidden = true;

	const sheet = document.createElement('form');
	sheet.id = 'hd-sheet';
	sheet.hidden = true;
	sheet.innerHTML = `
		<textarea rows="4" placeholder="여기에 입력 (한글 OK) → 삽입" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
		<div class="hd-sheet-actions">
			<button type="button" data-act="cancel">취소</button>
			<button type="submit">삽입</button>
		</div>`;
	sheet.querySelector('[data-act="cancel"]').onclick = closeInputSheet;

	// VS Code's connection handshake needs Web Crypto, which browsers only expose in a
	// secure context (https or localhost). Plain http://<LAN-IP> loads but never connects.
	const insecure = document.createElement('div');
	insecure.id = 'hd-insecure';
	insecure.hidden = window.isSecureContext;
	insecure.textContent = 'HTTPS나 localhost로 접속해야 VS Code가 연결됩니다 (현재 http). 안드로이드 USB: adb reverse, 원격: tailscale serve.';

	root.append(insecure, notice, keys, tabs);
	document.body.append(root, sheet);
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
	root.dataset.tab = state.tab;
	root.dataset.typing = TYPING_TABS.has(state.tab) ? '1' : '';
	for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === state.tab);
	for (const b of root.querySelectorAll('[data-key]')) {
		const def = KEY_DEFS[b.dataset.key];
		b.classList.toggle('active', !!(def?.sticky && state.sticky[def.sticky]));
	}
	requestAnimationFrame(relayout);
}

// VS Code defines its theme variables on the workbench element, and our bars live
// outside it. Copy the few we use onto the bars, and again whenever the theme changes.
const THEME_VARS = [
	'--vscode-sideBar-background', '--vscode-editor-background', '--vscode-foreground',
	'--vscode-descriptionForeground', '--vscode-focusBorder', '--vscode-panel-border',
	'--vscode-button-background', '--vscode-button-foreground',
	'--vscode-button-secondaryBackground', '--vscode-button-secondaryForeground',
	'--vscode-input-background', '--vscode-input-foreground',
	'--vscode-inputValidation-warningBackground', '--vscode-inputValidation-warningForeground',
	'--vscode-inputValidation-errorBackground', '--vscode-inputValidation-errorForeground',
	'--vscode-font-family', '--vscode-editor-font-family',
];

function syncTheme(workbench) {
	const copy = () => {
		const computed = getComputedStyle(workbench);
		for (const el of [document.getElementById('hd-root'), document.getElementById('hd-sheet')]) {
			for (const name of THEME_VARS) {
				const value = computed.getPropertyValue(name);
				if (value) el.style.setProperty(name, value);
				else el.style.removeProperty(name);
			}
		}
		const bg = computed.getPropertyValue('--vscode-sideBar-background') || computed.getPropertyValue('--vscode-editor-background');
		if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg.trim());
	};
	// Theme switches change the workbench class (vscode-theme-...) and restyle it.
	new MutationObserver(copy).observe(workbench, { attributes: true, attributeFilter: ['class'] });
	copy();
	setTimeout(copy, 2000); // theme CSS can land after the workbench element appears
}

// Restricted Mode disables the companion extension, so tabs would do nothing.
function watchTrust() {
	const notice = document.getElementById('hd-notice');
	const update = () => {
		const banner = document.querySelector(state.selectors.banner);
		const restricted = !!banner && banner.getBoundingClientRect().height > 0 && /Restricted Mode/i.test(banner.textContent);
		if (restricted === !notice.hidden) return;
		notice.hidden = !restricted;
		if (restricted) {
			notice.innerHTML = '';
			const text = document.createElement('span');
			text.textContent =
				state.config.companion?.mode === 'builtin'
					? '이 폴더를 신뢰해야 에이전트 확장이 동작합니다.'
					: '이 폴더를 신뢰해야 모바일 탭과 에이전트 확장이 동작합니다.';
			const manage = button({}, '신뢰 설정', () => [...banner.querySelectorAll('a')].find((a) => /Manage/i.test(a.textContent))?.click());
			notice.append(text, manage);
		}
		requestAnimationFrame(relayout);
	};
	let queued = false;
	const schedule = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			update();
		});
	};
	new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
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
			const el = document.querySelector(selector);
			if (el) {
				obs.disconnect();
				resolve(el);
			}
		});
		obs.observe(document.documentElement, { childList: true, subtree: true });
	});
}

async function main() {
	const [config, commands, selectors] = await Promise.all([loadJson('config.json'), loadJson('commands.json'), loadJson('selectors.json')]);
	Object.assign(state, { config, commands, selectors });

	const mobile = window.matchMedia(`(max-width: ${config.breakpoint}px), (pointer: coarse)`);
	if (!mobile.matches) return; // desktop browsers get plain VS Code

	document.documentElement.classList.add('hd-mobile');
	installViewportShim();
	build();
	render();

	vv?.addEventListener('resize', relayout);
	vv?.addEventListener('scroll', relayout);
	document.addEventListener('focusin', (e) => {
		if (e.target.matches?.(selectors.textInputs)) state.lastInput = e.target;
		requestAnimationFrame(relayout);
	});
	document.addEventListener('focusout', () => requestAnimationFrame(relayout));
	document.addEventListener('beforeinput', onBeforeInput, true);

	syncTheme(await waitFor(selectors.workbench));
	watchTrust();
	// Start on the editor once the companion extension had time to activate.
	setTimeout(() => showTab('code'), 2500);
}

main().catch((err) => console.error('[handide] layer failed', err));
