// VS Code's marketplace control list (blocked and deprecated extensions), chat participant
// registry and MCP server list come from main.vscode-cdn.net, which answers with CORS
// headers for http(s)://localhost pages only; the UI's translation (ko-kr, ...) comes from
// www.vscode-unpkg.net, which sends none. Opened through the ts.net link or the LAN
// address, the browser blocked them ("No 'Access-Control-Allow-Origin' header"), and a
// Korean phone got the English UI. So the workbench is pointed at handide for them, and
// handide fetches them.
//
//   phone ── /__handide/cdn/extensions/marketplace.json ──> handide ──> main.vscode-cdn.net
import https from 'node:https';

export const CDN_PREFIX = '/__handide/cdn/';
// What may be fetched, and from where: these files only, nothing else of these hosts.
const SOURCES = [
	{ path: /^(extensions|mcp|core)\/[\w.-]+\.json$/, base: 'https://main.vscode-cdn.net/' },
	// The UI's translation (a module script the server picks by the browser's language).
	{ path: /^nls\/[0-9a-f]{40}\/[\w.-]+\/[\w-]+\/nls\.messages\.js$/, base: 'https://www.vscode-unpkg.net/' },
];
const CACHE_MS = 10 * 60_000;
const TOKEN_COOKIE = /(?:^|;\s*)vscode-tkn=([^;]*)/;

/**
 * The workbench page: its product configuration (HTML-escaped JSON in a meta tag) points
 * these files at handide. chatParticipantRegistry is not in it (it comes from the product
 * built into the workbench), so it is added; the page's values override the built-in ones.
 */
export function useCdnProxy(html, origin) {
	if (html.includes(CDN_PREFIX)) return html;
	const local = `${origin}${CDN_PREFIX}`;
	const marker = 'productConfiguration&quot;:{';
	if (!html.includes(marker)) return html;
	return html
		.replace(/(&quot;(?:controlUrl|mcpUrl|chatParticipantRegistry)&quot;:&quot;)https:\/\/main\.vscode-cdn\.net\//g, `$1${local}`)
		.replace(marker, `${marker}&quot;chatParticipantRegistry&quot;:&quot;${local}extensions/chat.json&quot;,`)
		.replace(/(<script type="module" src=")https:\/\/www\.vscode-unpkg\.net\/nls\//, `$1${CDN_PREFIX}nls/`);
}

export function createCdnProxy({ token, log }) {
	const cache = new Map(); // path -> { at, status, type, body }

	const get = (url) =>
		new Promise((resolve, reject) => {
			const req = https.get(url, { timeout: 15_000 }, (res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || 'application/json', body: Buffer.concat(chunks) }));
				res.on('error', reject);
			});
			req.on('timeout', () => req.destroy(new Error('timed out')));
			req.on('error', reject);
		});

	/** Handles /__handide/cdn/<path>; false for any other request. */
	async function handle(req, res) {
		const pathname = req.url.split('?')[0];
		if (!pathname.startsWith(CDN_PREFIX)) return false;
		const send = (status, type, body, extra = {}) => {
			res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
			res.end(body);
		};
		if (TOKEN_COOKIE.exec(req.headers.cookie || '')?.[1] !== token) return send(403, 'text/plain', 'forbidden'), true;
		const path = pathname.slice(CDN_PREFIX.length);
		const source = SOURCES.find((s) => s.path.test(path));
		if (req.method !== 'GET' || !source) return send(404, 'text/plain', 'not found'), true;
		let hit = cache.get(path);
		if (!hit || Date.now() - hit.at > CACHE_MS) {
			try {
				const r = await get(`${source.base}${path}`);
				if (r.status === 200) cache.set(path, (hit = { at: Date.now(), ...r }));
				else if (!hit) return send(r.status, 'text/plain', `vscode-cdn answered ${r.status}`), true;
			} catch (err) {
				log(`vscode-cdn ${path}: ${err.message}`);
				if (!hit) return send(502, 'text/plain', 'vscode-cdn not reachable'), true;
			}
		}
		send(200, hit.type, hit.body);
		return true;
	}

	return { handle };
}
