// handremote (a separate project: the PC's windows, widgets, tray and servers on the phone)
// through handide's own address and access token. handremote writes where it listens for
// handide (127.0.0.1 only) and a secret to ~/.handremote/endpoint.json; handide relays
// /__handide/screen/<path> there with that secret and says which remote mode it runs in,
// so handremote keeps its SYSTEM helper off behind a public link.
//
//   phone ── /__handide/screen/api/list ──> handide (token cookie) ──> 127.0.0.1:<port>/api/list
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';

export const SCREEN_PREFIX = '/__handide/screen';
export const SCREEN_STATUS = '/__handide/screen-status';
const API = 1; // the handremote link API this handide speaks
const TOKEN_COOKIE = 'vscode-tkn';

const cookies = (req) => {
	const out = {};
	for (const part of (req.headers.cookie || '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k) out[k] = v.join('=');
	}
	return out;
};

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
};

export function createScreenLink({ token, remoteMode, log }) {
	const file = join(process.env.HANDREMOTE_HOME || join(os.homedir(), '.handremote'), 'endpoint.json');
	const authed = (req) => cookies(req)[TOKEN_COOKIE] === token;

	/** handremote's link endpoint, or null when it is not running. */
	function endpoint() {
		try {
			const ep = JSON.parse(readFileSync(file, 'utf8'));
			return ep.port && ep.secret && alive(ep.pid) ? ep : null;
		} catch {
			return null;
		}
	}

	function headersFor(req, ep) {
		const headers = { ...req.headers, host: `127.0.0.1:${ep.port}`, 'x-handremote-secret': ep.secret, 'x-handremote-remote': remoteMode() };
		delete headers.cookie; // handide's access token stays with handide
		for (const k of Object.keys(headers)) if (k.startsWith('x-forwarded-')) delete headers[k];
		return headers;
	}

	const sendJson = (res, status, body) => {
		res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(body));
	};

	function handle(req, res) {
		const pathname = req.url.split('?')[0];
		if (pathname === SCREEN_STATUS) {
			if (!authed(req)) return sendJson(res, 403, { ok: false }), true;
			const ep = endpoint();
			sendJson(res, 200, { ok: true, available: !!ep, compatible: !!ep && ep.api === API, version: ep?.version ?? null });
			return true;
		}
		if (pathname !== SCREEN_PREFIX && !pathname.startsWith(`${SCREEN_PREFIX}/`)) return false;
		if (!authed(req)) return sendJson(res, 403, { ok: false, error: 'open handide from its link first' }), true;
		// Its page uses relative URLs: it must be served from the folder, with the slash.
		if (pathname === SCREEN_PREFIX) {
			res.writeHead(302, { location: `${SCREEN_PREFIX}/${req.url.slice(pathname.length)}` });
			res.end();
			return true;
		}
		const ep = endpoint();
		if (!ep) return sendJson(res, 502, { ok: false, error: 'handremote is not running on this PC' }), true;
		const path = req.url.slice(SCREEN_PREFIX.length) || '/';
		const up = http.request({ host: '127.0.0.1', port: ep.port, method: req.method, path, headers: headersFor(req, ep) }, (upRes) => {
			res.writeHead(upRes.statusCode, upRes.headers);
			upRes.pipe(res);
		});
		up.on('error', (err) => {
			log(`handremote: ${err.message}`);
			if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'handremote did not answer' });
			else res.destroy();
		});
		req.pipe(up);
		return true;
	}

	/** The window viewer's WebSocket. */
	function upgrade(req, socket, head) {
		const pathname = req.url.split('?')[0];
		if (!pathname.startsWith(`${SCREEN_PREFIX}/`)) return false;
		const ep = authed(req) ? endpoint() : null;
		if (!ep) {
			socket.destroy();
			return true;
		}
		const upstream = net.connect(ep.port, '127.0.0.1', () => {
			const lines = [`${req.method} ${req.url.slice(SCREEN_PREFIX.length)} HTTP/${req.httpVersion}`];
			for (const [k, v] of Object.entries(headersFor(req, ep))) for (const value of [].concat(v)) lines.push(`${k}: ${value}`);
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
