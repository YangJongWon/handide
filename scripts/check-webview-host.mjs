#!/usr/bin/env node
// The webview host page as handide serves it (proxy/webview.mjs: patchWebviewHost), on the
// VS Code server installed here (~/.vscode/cli/serve-web/<commit>, newest first):
//   - the patches apply (polyfills, same-origin parent, the service worker wait) and the
//     page's CSP carries the new script's hash, or the browser would refuse to run it
//   - the wait for the service worker ends once the page is controlled by the webview's
//     worker even if VS Code's promise never settles (iOS Safari 26: every extension panel
//     stayed blank below its header), at once when it settles, and not for another worker
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { patchWebviewHost } from '../proxy/webview.mjs';

const root = join(process.env.VSCODE_CLI_DATA_DIR || join(homedir(), '.vscode', 'cli'), 'serve-web');
const PRE = ['out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', 'index.html'];
const builds = existsSync(root)
	? readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, ...PRE))).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
	: [];
if (!builds.length) {
	console.log(`SKIP: no VS Code server under ${root} (run handide once)`);
	process.exit(0);
}
const html = readFileSync(join(builds[0], ...PRE), 'utf8');
const out = patchWebviewHost(html);
assert.notEqual(out, html, `the host page of ${builds[0]} was left unpatched: VS Code changed it, see proxy/webview.mjs`);
const script = /<script async type="module">([\s\S]*?)<\/script>/.exec(out)[1];
assert.ok(script.includes('DisposableStack') && script.includes('location.origin === parentOrigin'), 'polyfills and the same-origin parent check');
assert.ok(script.includes('const hdWorkerReady') && script.includes('await hdWorkerReady(workerReady);'), 'the service worker wait');
const hash = `sha256-${createHash('sha256').update(script.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}`;
assert.ok(out.includes(hash), "the page's CSP allows the patched script");
console.log(`PASS: host page patched, CSP hash updated (${builds[0].split(/[\\/]/).pop().slice(0, 10)})`);

const helper = /const hdWorkerReady[\s\S]*?\n\}\);\n/.exec(script)[0];
const withController = (scriptURL) => Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { controller: scriptURL && { scriptURL } } }, configurable: true });
const hdWorkerReady = new Function(`${helper}; return hdWorkerReady;`)();
const never = () => new Promise(() => {});
const within = (p, ms) => Promise.race([p.then(() => 'resolved'), new Promise((ok) => setTimeout(() => ok('waiting'), ms))]);

withController('https://x/stable-1/static/out/vs/workbench/contrib/webview/browser/pre/service-worker.js?v=6');
assert.equal(await within(hdWorkerReady(never()), 4000), 'resolved', 'controlled by the webview worker: no endless wait');
let t = Date.now();
await hdWorkerReady(Promise.resolve());
assert.ok(Date.now() - t < 100, 'a settled promise is not delayed');
withController('https://x/__handide/sw.js');
assert.equal(await within(hdWorkerReady(never()), 3500), 'waiting', "another worker (handide's sw.js) does not count");
withController(null);
assert.equal(await within(hdWorkerReady(never()), 3500), 'waiting', 'no worker yet: keeps waiting');
await assert.rejects(hdWorkerReady(Promise.reject(new Error('no sw'))), /no sw/, 'a failure still reaches the page (fatal-error)');
console.log('PASS: the service worker wait ends when the webview worker controls the page, and only then');
process.exit(0);
