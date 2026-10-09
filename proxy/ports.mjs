// Port forwarding: a link to http://localhost:<port> opened on the phone points at the
// phone itself, so the dev server running on the PC is unreachable. The layer rewrites
// such links to /__handide/port/<port>/<path>; the proxy remembers the port in a cookie,
// sends the browser on to the plain <path> and serves every request that is not the
// editor's own from that port. Apps that use absolute paths (/login, /_next/…) and
// client-side routing keep working that way, without rewriting their pages.
//
//   phone ── /__handide/port/3300/login ──> proxy: cookie port=3300, 302 → /login
//   phone ── /login, /_next/app.js, … ────> proxy ──> 127.0.0.1:3300
//
// The editor owns "/" and "/<quality>-<commit>/…"; those are never forwarded, so the
// app's own root page is served under /__handide/port/<port>/ instead.
import http from 'node:http';
import net from 'node:net';

export const PORT_PREFIX = '/__handide/port/';
const PORT_COOKIE = '__handide_port';
const TOKEN_COOKIE = 'vscode-tkn';
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/;

const cookies = (req) => {
	const out = {};
	for (const part of (req.headers.cookie || '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k) out[k] = v.join('=');
	}
	return out;
};

const validPort = (s) => {
	const n = Number(s);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

const isEditorPath = (pathname) =>
	pathname === '/' || pathname.startsWith('/__handide/') || /^\/[a-z]+-[0-9a-f]{40}(\/|$)/.test(pathname);

/** The request's own same-origin referer path, or null. */
function refererPath(req) {
	try {
		const url = new URL(req.headers.referer);
		return url.host === req.headers.host ? url.pathname : null;
	} catch {
		return null;
	}
}

export function createPortForwarder({ token, log }) {
	const authed = (req) => cookies(req)[TOKEN_COOKIE] === token;

	/**
	 * Where a request goes: { port, path } for a forwarded app, { prefix } for the
	 * /__handide/port/ entry point, or null for the editor.
	 */
	function route(req) {
		const pathname = req.url.split('?')[0];
		const query = req.url.slice(pathname.length);
		if (pathname.startsWith(PORT_PREFIX)) {
			const [, portText, rest = ''] = pathname.slice(PORT_PREFIX.length - 1).match(/^\/([^/]*)(\/.*)?$/) || [];
			return { prefix: true, port: validPort(portText), path: (rest || '/') + query };
		}
		if (!authed(req)) return null;
		const port = validPort(cookies(req)[PORT_COOKIE]);
		if (!port) return null;
		if (!isEditorPath(pathname)) return { port, path: req.url };
		// "/" belongs to the editor, unless the app's own pages ask for it (a link home,
		// a client-side fetch, Vite's HMR socket).
		const from = refererPath(req);
		const fromApp = from && (from.startsWith(PORT_PREFIX) || !isEditorPath(from));
		const viteHmr = /vite-hmr/.test(req.headers['sec-websocket-protocol'] || '');
		if (pathname === '/' && (fromApp || viteHmr)) return { port, path: req.url };
		return null;
	}

	/** Headers as the app would see them from a browser on the PC. */
	function upstreamHeaders(req, port) {
		const headers = { ...req.headers, host: `localhost:${port}` };
		for (const k of Object.keys(headers)) if (k.startsWith('x-forwarded-')) delete headers[k];
		if (headers.origin) headers.origin = `http://localhost:${port}`;
		if (headers.referer) {
			try {
				const url = new URL(headers.referer);
				const own = `${PORT_PREFIX}${port}`;
				const path = url.pathname.startsWith(own) ? url.pathname.slice(own.length) || '/' : url.pathname;
				headers.referer = `http://localhost:${port}${path}${url.search}`;
			} catch {
				delete headers.referer;
			}
		}
		// The editor's access token stays with the editor.
		const kept = (req.headers.cookie || '')
			.split(';')
			.map((c) => c.trim())
			.filter((c) => c && !c.startsWith(`${TOKEN_COOKIE}=`) && !c.startsWith(`${PORT_COOKIE}=`));
		if (kept.length) headers.cookie = kept.join('; ');
		else delete headers.cookie;
		return headers;
	}

	/** Redirects inside the app stay on the phone's address; other local ports get forwarded too. */
	function fixLocation(location, port) {
		let url;
		try {
			url = new URL(location, `http://localhost:${port}`);
		} catch {
			return location;
		}
		if (!LOOPBACK.test(url.hostname) || !/^https?:$/.test(url.protocol)) return location;
		const target = validPort(url.port || (url.protocol === 'https:' ? 443 : 80));
		const path = `${url.pathname}${url.search}${url.hash}`;
		return target === port ? path : `${PORT_PREFIX}${target}${path}`;
	}

	const portCookie = (port) => `${PORT_COOKIE}=${port}; Path=/; HttpOnly; SameSite=Lax`;

	function sendError(res, status, text) {
		res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>handide</title><body style="font:16px/1.5 system-ui,sans-serif;padding:24px;max-width:36em;margin:auto">${text}</body>`);
	}

	function forward(req, res, port, path, extraCookie) {
		const upReq = http.request({ host: '127.0.0.1', port, method: req.method, path, headers: upstreamHeaders(req, port) }, (upRes) => {
			const out = { ...upRes.headers };
			if (out.location) out.location = fixLocation(out.location, port);
			const setCookie = [].concat(out['set-cookie'] || []).map((c) => c.replace(/;\s*domain=[^;]*/i, ''));
			if (extraCookie) setCookie.push(extraCookie);
			if (setCookie.length) out['set-cookie'] = setCookie;
			res.writeHead(upRes.statusCode, out);
			upRes.pipe(res);
		});
		upReq.on('error', (err) => {
			if (res.headersSent) return res.destroy();
			if (err.code === 'ECONNREFUSED') sendError(res, 502, `Nothing is running on <b>localhost:${port}</b> on the PC. Start the app there, then reload.`);
			else {
				log(`port ${port}: ${err.message}`);
				sendError(res, 502, `Could not reach localhost:${port} on the PC (${err.message}).`);
			}
		});
		req.pipe(upReq);
	}

	/** Handles the request if it belongs to a forwarded port; returns false for the editor's own. */
	function handle(req, res) {
		const r = route(req);
		if (!r) return false;
		if (r.prefix) {
			if (!authed(req)) {
				sendError(res, 403, 'Open handide on this device first (its QR code or link), then try the link again.');
				return true;
			}
			if (!r.port) {
				sendError(res, 404, 'Not a port number.');
				return true;
			}
			// The app's root page cannot move to "/" (the editor's), so it is served here.
			if (r.path === '/' || r.path.startsWith('/?')) forward(req, res, r.port, r.path, portCookie(r.port));
			else {
				res.writeHead(302, { location: r.path, 'set-cookie': portCookie(r.port), 'cache-control': 'no-store' });
				res.end();
			}
			return true;
		}
		forward(req, res, r.port, r.path);
		return true;
	}

	/** WebSockets of a forwarded app (hot reload); returns false for the editor's own. */
	function upgrade(req, socket, head) {
		const r = route(req);
		if (!r) return false;
		if (!r.port || (r.prefix && !authed(req))) {
			socket.destroy();
			return true;
		}
		const upstream = net.connect(r.port, '127.0.0.1', () => {
			const lines = [`${req.method} ${r.path} HTTP/${req.httpVersion}`];
			for (const [k, v] of Object.entries(upstreamHeaders(req, r.port))) {
				for (const value of [].concat(v)) lines.push(`${k}: ${value}`);
			}
			upstream.write(lines.join('\r\n') + '\r\n\r\n');
			if (head?.length) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		const close = () => {
			upstream.destroy();
			socket.destroy();
		};
		upstream.on('error', close);
		socket.on('error', close);
		upstream.on('close', close);
		socket.on('close', close);
		return true;
	}

	return { handle, upgrade };
}
