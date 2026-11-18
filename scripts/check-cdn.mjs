#!/usr/bin/env node
// VS Code's CDN files through handide (proxy/cdn.mjs), which the CDN serves to localhost
// pages only: from the ts.net link the browser blocked the marketplace control list, the
// chat registry and the UI's translation (a Korean phone got English).
//   - the workbench page points them at /__handide/cdn/ (and only them)
//   - the relay wants the access token and fetches the listed files only
// No network needed: the fetch itself is checked in the browser (see the commit).
import assert from 'node:assert/strict';
import http from 'node:http';
import { CDN_PREFIX, createCdnProxy, useCdnProxy } from '../proxy/cdn.mjs';

const q = (s) => s.replaceAll('"', '&quot;');
const config = q(JSON.stringify({ productConfiguration: { webEndpointUrl: 'https://main.vscode-cdn.net', extensionsGallery: { controlUrl: 'https://main.vscode-cdn.net/extensions/marketplace.json', mcpUrl: 'https://main.vscode-cdn.net/mcp/servers.json', serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery' } } }));
const page = `<meta id="vscode-workbench-web-configuration" data-settings="${config}">
<script type="module" src="/stable-x/static/out/nls.messages.js"></script>
<script type="module" src="https://www.vscode-unpkg.net/nls/0123456789abcdef0123456789abcdef01234567/1.145.2/ko-kr/nls.messages.js"></script>`;
const origin = 'https://pc.tail0.ts.net';
const out = useCdnProxy(page, origin);
const settings = JSON.parse(/data-settings="([^"]*)"/.exec(out)[1].replaceAll('&quot;', '"'));
const g = settings.productConfiguration.extensionsGallery;
assert.equal(g.controlUrl, `${origin}${CDN_PREFIX}extensions/marketplace.json`);
assert.equal(g.mcpUrl, `${origin}${CDN_PREFIX}mcp/servers.json`);
assert.equal(settings.productConfiguration.chatParticipantRegistry, `${origin}${CDN_PREFIX}extensions/chat.json`);
assert.equal(settings.productConfiguration.webEndpointUrl, 'https://main.vscode-cdn.net', 'other CDN settings are left alone');
assert.equal(g.serviceUrl, 'https://marketplace.visualstudio.com/_apis/public/gallery');
assert.ok(out.includes(`src="${CDN_PREFIX}nls/0123456789abcdef0123456789abcdef01234567/1.145.2/ko-kr/nls.messages.js"`), 'the translation');
assert.ok(out.includes('src="/stable-x/static/out/nls.messages.js"'), 'the built-in English messages stay');
assert.equal(useCdnProxy(out, origin), out, 'applied once');
assert.equal(useCdnProxy('<html>no config</html>', origin), '<html>no config</html>');
console.log('PASS: the workbench page points the marketplace list, chat registry, MCP list and translation at handide');

const token = 'tok123';
const cdn = createCdnProxy({ token, log: () => {} });
const server = http.createServer((req, res) => {
	if (!req.url.startsWith(CDN_PREFIX)) return res.writeHead(418).end();
	cdn.handle(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// http.request sends the path as written (fetch would resolve "..").
const get = (path, cookie = `vscode-tkn=${token}`) =>
	new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `${CDN_PREFIX}${path}`, headers: { cookie }, agent: false }, (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on('error', reject);
		req.end();
	});
try {
	assert.equal(await get('extensions/marketplace.json', ''), 403, 'no access token');
	assert.equal(await get('extensions/marketplace.json', 'vscode-tkn=wrong'), 403);
	for (const p of ['extensions/x.js', 'extensions/../../secret.json', 'other/a.json', 'nls/notacommit/1.0/ko/nls.messages.js', 'nls/0123456789abcdef0123456789abcdef01234567/1.0/ko/other.js', '']) {
		assert.equal(await get(p), 404, p);
	}
	console.log('PASS: the relay wants the access token and serves the listed files only');
} finally {
	server.close();
	server.closeAllConnections();
}
process.exit(0);
