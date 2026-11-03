// Extension webviews (Codex, Claude Code… chats) run in the phone's browser, not in the
// desktop editor's Chromium, so a webview written for Chromium can use what iOS WebKit
// lacks: Codex calls DisposableStack and fails on an iPhone with "Can't find variable:
// DisposableStack". The extension's scripts reach the webview over the editor's WebSocket,
// out of handide's reach, but every webview's document is built by VS Code's webview host
// page (pre/index.html), which prepends its own script to it. handide serves that page
// from the editor server instead of vscode-cdn.net (`webviewEndpoint`, as code-server does)
// and adds polyfills to that script, before the extension's own CSP and code.
import { createHash } from 'node:crypto';

const PRE_PATH = '/out/vs/workbench/contrib/webview/browser/pre/';

/** Missing in Safari: explicit resource management (DisposableStack, Symbol.dispose…). */
const POLYFILL = `(() => {
	if (typeof DisposableStack === 'function' && typeof AsyncDisposableStack === 'function') return;
	if (!Symbol.dispose) Object.defineProperty(Symbol, 'dispose', { value: Symbol('Symbol.dispose') });
	if (!Symbol.asyncDispose) Object.defineProperty(Symbol, 'asyncDispose', { value: Symbol('Symbol.asyncDispose') });
	if (typeof SuppressedError !== 'function') {
		globalThis.SuppressedError = class SuppressedError extends Error {
			constructor(error, suppressed, message) {
				super(message);
				this.name = 'SuppressedError';
				this.error = error;
				this.suppressed = suppressed;
			}
		};
	}
	const disposer = (value, isAsync) => {
		const m = (isAsync && value[Symbol.asyncDispose]) || value[Symbol.dispose];
		if (typeof m !== 'function') throw new TypeError('the value is not disposable');
		return () => m.call(value);
	};
	const base = (isAsync) =>
		class {
			#stack = [];
			#disposed = false;
			get disposed() { return this.#disposed; }
			_check() { if (this.#disposed) throw new ReferenceError('the stack is already disposed'); }
			_take() { this.#disposed = true; const s = this.#stack; this.#stack = []; return s; }
			use(value) { this._check(); if (value != null) this.#stack.push(disposer(value, isAsync)); return value; }
			adopt(value, onDispose) { this._check(); this.#stack.push(() => onDispose(value)); return value; }
			defer(onDispose) { this._check(); this.#stack.push(() => onDispose()); }
			move() { this._check(); const next = new this.constructor(); next.#stack = this._take(); return next; }
		};
	if (typeof DisposableStack !== 'function') {
		globalThis.DisposableStack = class DisposableStack extends base(false) {
			dispose() {
				if (this.disposed) return;
				const stack = this._take();
				let error, failed = false;
				while (stack.length) {
					try { stack.pop()(); } catch (e) { error = failed ? new SuppressedError(e, error, '') : e; failed = true; }
				}
				if (failed) throw error;
			}
			[Symbol.dispose]() { this.dispose(); }
		};
	}
	if (typeof AsyncDisposableStack !== 'function') {
		globalThis.AsyncDisposableStack = class AsyncDisposableStack extends base(true) {
			async disposeAsync() {
				if (this.disposed) return;
				const stack = this._take();
				let error, failed = false;
				while (stack.length) {
					try { await stack.pop()(); } catch (e) { error = failed ? new SuppressedError(e, error, '') : e; failed = true; }
				}
				if (failed) throw error;
			}
			[Symbol.asyncDispose]() { return this.disposeAsync(); }
		};
	}
})();
`;

// Of the script as the HTML parser hands it over: line breaks normalized to \n (the editor
// server's copy has \r\n on Windows).
const sha256 = (text) => `sha256-${createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}`;

export const isWebviewHost = (pathname) => pathname.endsWith(`${PRE_PATH}index.html`);

/** The webview host page and its service worker (static VS Code files, no user data). */
export const isWebviewAsset = (pathname) => pathname.includes(PRE_PATH);

/**
 * Whether webviews can come from handide for this request. They need a service worker,
 * and browsers refuse to register one on an origin whose certificate they do not trust,
 * even after the warning was accepted: on the LAN address (self-signed) every webview
 * would stay blank. There vscode-cdn.net keeps serving them. Through Tailscale or
 * Cloudflare (real certificate, X-Forwarded-Proto set) or plain http://localhost it works.
 */
export const canServeWebviews = (req, selfSigned) =>
	!selfSigned || !req.socket.encrypted || Boolean(req.headers['x-forwarded-proto']);

/**
 * A module service worker's script is fetched without cookies, so the editor server,
 * which wants its token cookie on every request, answers 403. The webview files are
 * VS Code's own static files: handide adds the token for them.
 */
export function withToken(headers, token) {
	if (!token || /(?:^|;\s*)vscode-tkn=/.test(headers.cookie || '')) return headers;
	return { ...headers, cookie: headers.cookie ? `${headers.cookie}; vscode-tkn=${token}` : `vscode-tkn=${token}` };
}

/**
 * The workbench page: webviews come from the editor server (through handide) instead of
 * vscode-cdn.net. Its config is HTML-escaped JSON in a meta tag, next to the base URL.
 * The endpoint has to be absolute ({origin} as the phone sees it): VS Code takes the
 * origin it accepts webview messages from out of it, and a bare path gives none, so
 * every message would be dropped ("mismatched origins") and the webview stay blank.
 */
export function useLocalWebviews(html, origin) {
	if (html.includes('webviewEndpoint')) return html;
	const base = /id="vscode-workbench-web-base-url" data-settings="([^"]*)"/.exec(html)?.[1];
	if (!base) return html;
	const path = `${base.replace(/\/$/, '')}${PRE_PATH}`.replace(/\/$/, '');
	const endpoint = /^https?:\/\//.test(path) ? path : `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
	return html.replace(/(id="vscode-workbench-web-configuration" data-settings=")\{/, `$1{&quot;webviewEndpoint&quot;:&quot;${endpoint}&quot;,`);
}

/**
 * The webview host page: its default script, prepended to every webview document, starts
 * with the polyfills. The page allows its inline script by hash, so the hash is updated.
 * Left as it is when VS Code changes the page beyond recognition.
 */
export function patchWebviewHost(html) {
	const m = /(<script async type="module">)([\s\S]*?)(<\/script>)/.exec(html);
	if (!m) return html;
	const script = m[2];
	const oldHash = sha256(script);
	const hook = 'defaultScript.textContent = getVsCodeApiScript(';
	// The page only signals ready when its hostname is a hash of the parent's origin (a
	// vscode-cdn.net subdomain); served next to the workbench it never is, and every webview
	// stays blank. Same origin as the parent is accepted too, as code-server does.
	const originCheck = 'if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + \'.\')) {';
	if (!html.includes(oldHash) || !script.includes(hook) || !script.includes(originCheck)) return html;
	const patched = script
		.replace(hook, `defaultScript.textContent = ${JSON.stringify(POLYFILL)} + getVsCodeApiScript(`)
		.replace(originCheck, 'if (location.origin === parentOrigin || hostname === parentOriginHash || hostname.startsWith(parentOriginHash + \'.\')) {');
	return html.replace(m[0], m[1] + patched + m[3]).replace(oldHash, sha256(patched));
}
