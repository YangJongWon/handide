// Phone camera -> "handide Camera", a virtual webcam every Windows app can pick
// (Chrome, Zoom, Teams, OBS ...).
//
//   phone (layer/camera.js) ── wss /__handide/camera/ws, binary JPEG frames ──> proxy
//   proxy ── stdin [u32 length][JPEG] ──> native/bin/x64/handide-cam.exe ──> handide-camera.dll
//
// The DLL is softcam (MIT) under its own name and IDs (native/build.mjs). Registering it
// with DirectShow needs admin rights once: `handide camera install` (one UAC prompt).
// The helper runs only while a phone is sending, plus a short grace period, so the
// waiting screen covers quick reconnects (switching cameras, a network blip).
//
// Flow control: the server answers every frame with "k"; the phone keeps at most two
// frames in flight, so a slow link lowers the frame rate instead of building up delay.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAMERA_WS_PATH = '/__handide/camera/ws';
export const CAMERA_STATUS_PATH = '/__handide/camera/status';
const TOKEN_COOKIE = 'vscode-tkn';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HELPER = process.env.HANDIDE_CAMERA_HELPER || join(ROOT, 'native', 'bin', 'x64', 'handide-cam.exe');
const GRACE_MS = Number(process.env.HANDIDE_CAMERA_GRACE_MS) || 20_000;
// Tests point HANDIDE_CAMERA_HELPER at a .mjs stand-in (scripts/check-camera.mjs).
const helperCmd = (args) => (HELPER.endsWith('.mjs') ? [process.execPath, [HELPER, ...args]] : [HELPER, args]);
const MAX_FRAME = 8 << 20;

const cookie = (req, name) => {
	for (const part of (req.headers.cookie || '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return decodeURIComponent(v.join('='));
	}
	return null;
};

/** `registered` | `not-registered` | `missing` (helper not built) | `unsupported` (not Windows). */
export function cameraStatus() {
	if (process.platform !== 'win32' && !process.env.HANDIDE_CAMERA_HELPER) return Promise.resolve('unsupported');
	if (!existsSync(HELPER)) return Promise.resolve('missing');
	return new Promise((resolve) => {
		execFile(...helperCmd(['status']), { windowsHide: true, timeout: 5000 }, (err, out) => {
			resolve(err ? 'missing' : String(out).trim() === 'registered' ? 'registered' : 'not-registered');
		});
	});
}

// ---------------------------------------------------------------- minimal WebSocket server
// Only what the camera page needs: binary/text messages from a browser, ping/close.
function accept(req, socket, head) {
	const key = req.headers['sec-websocket-key'];
	if (!key) return false;
	const acceptKey = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
	if (head?.length) socket.unshift(head);
	socket.setNoDelay(true);
	return true;
}

function frame(opcode, payload = Buffer.alloc(0)) {
	const n = payload.length;
	const head = n < 126 ? Buffer.from([0x80 | opcode, n])
		: n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
			: Buffer.concat([Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
	return Buffer.concat([head, payload]);
}

/** Calls onMessage(opcode, Buffer) for each complete (possibly fragmented) message. */
function reader(socket, onMessage, onClose) {
	let buf = Buffer.alloc(0), parts = [], partOp = 0;
	socket.on('data', (chunk) => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
		for (;;) {
			if (buf.length < 2) return;
			const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
			let len = buf[1] & 0x7f, off = 2;
			if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
			else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
			if (len > MAX_FRAME) return socket.destroy();
			const need = off + (masked ? 4 : 0) + len;
			if (buf.length < need) return;
			let payload = buf.subarray(off + (masked ? 4 : 0), need);
			if (masked) {
				const m = buf.subarray(off, off + 4);
				payload = Buffer.from(payload);
				for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
			}
			buf = buf.subarray(need);
			if (op === 0x8) { socket.end(frame(0x8)); return onClose(); }
			if (op === 0x9) { socket.write(frame(0xA, payload)); continue; }
			if (op === 0xA) continue;
			if (op !== 0) { partOp = op; parts = []; }
			parts.push(payload);
			if (fin) {
				const msg = parts.length === 1 ? parts[0] : Buffer.concat(parts);
				parts = [];
				onMessage(partOp, msg);
			}
		}
	});
	socket.on('close', onClose);
	socket.on('error', () => socket.destroy());
}

// ---------------------------------------------------------------- camera
export function createCamera({ token, log = () => {} }) {
	let helper = null; // { proc, ready }
	let phone = null; // the socket currently sending
	let idleTimer = null;
	let frames = 0;

	function startHelper() {
		if (helper) return helper;
		const proc = spawn(...helperCmd(['run', '1280', '720', '30']), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
		helper = { proc };
		proc.stdin.on('error', () => {});
		proc.stderr.on('data', (d) => log(`camera: ${String(d).trim()}`));
		proc.on('exit', (code) => {
			log(`camera: helper exited (${code})`);
			if (helper?.proc === proc) helper = null;
		});
		proc.on('error', (err) => {
			log(`camera: ${err.message}`);
			if (helper?.proc === proc) helper = null;
		});
		return helper;
	}

	function stopHelperLater() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			if (phone || !helper) return;
			helper.proc.stdin.end();
			const p = helper.proc;
			setTimeout(() => p.exitCode === null && p.kill(), 3000);
		}, GRACE_MS);
	}

	function send(jpeg) {
		const h = startHelper();
		if (!h.proc.stdin.writable) return false;
		// The helper fell behind (the phone keeps two frames in flight, so this is rare):
		// skip this frame, the next one is fresher.
		if (h.proc.stdin.writableLength > 2 << 20) return false;
		const len = Buffer.alloc(4);
		len.writeUInt32LE(jpeg.length);
		h.proc.stdin.write(len);
		h.proc.stdin.write(jpeg);
		return true;
	}

	function phoneGone(socket) {
		if (phone !== socket) return;
		phone = null;
		if (helper?.proc.stdin.writable) helper.proc.stdin.write(Buffer.alloc(4)); // length 0: waiting screen
		stopHelperLater();
		log(`camera: phone disconnected after ${frames} frames`);
	}

	async function upgrade(req, socket, head) {
		if (req.url.split('?')[0] !== CAMERA_WS_PATH) return false;
		// Same check as the layer's HTTP endpoints, but browsers can't add headers to a
		// WebSocket: the token cookie plus a same-origin Origin header instead.
		const origin = req.headers.origin || '';
		const sameOrigin = origin.replace(/^https?:\/\//, '') === req.headers.host;
		if (cookie(req, TOKEN_COOKIE) !== token || !sameOrigin) {
			socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
			return true;
		}
		const status = await cameraStatus();
		if (!accept(req, socket, head)) { socket.destroy(); return true; }
		if (status !== 'registered') {
			socket.write(frame(0x1, Buffer.from(JSON.stringify({ error: status }))));
			socket.end(frame(0x8));
			return true;
		}
		// One phone at a time: a newer connection takes over.
		if (phone) phone.end(frame(0x8, Buffer.from([0x0f, 0xa0]))); // 4000: replaced
		phone = socket;
		frames = 0;
		clearTimeout(idleTimer);
		startHelper();
		socket.write(frame(0x1, Buffer.from(JSON.stringify({ ok: true, width: 1280, height: 720 }))));
		log('camera: phone connected');
		reader(socket, (op, msg) => {
			if (op !== 0x2 || phone !== socket) return;
			if (send(msg)) frames++;
			socket.write(frame(0x1, Buffer.from('k')));
		}, () => phoneGone(socket));
		return true;
	}

	async function handle(req, res) {
		if (req.url.split('?')[0] !== CAMERA_STATUS_PATH) return false;
		if (cookie(req, TOKEN_COOKIE) !== token || req.headers['x-handide'] !== '1') {
			res.writeHead(403).end();
			return true;
		}
		const body = JSON.stringify({ ok: true, status: await cameraStatus(), active: !!phone });
		res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
		return true;
	}

	function close() {
		clearTimeout(idleTimer);
		phone?.destroy();
		helper?.proc.kill();
	}

	return { upgrade, handle, close };
}

/** `handide camera install | uninstall | status` */
export async function cameraCommand(args) {
	const cmd = args[0] || 'status';
	const status = await cameraStatus();
	if (status === 'unsupported') return console.log('The PC webcam is Windows only for now.'), 1;
	if (status === 'missing') return console.log(`Not built: ${HELPER}\nBuild it with: node native/build.mjs`), 1;
	if (cmd === 'status') return console.log(status), 0;
	if (cmd !== 'install' && cmd !== 'uninstall') return console.log('usage: handide camera install | uninstall | status'), 1;
	console.log('Windows will ask for administrator permission (UAC) once.');
	const code = await new Promise((resolve) => {
		const p = spawn(...helperCmd([cmd === 'install' ? 'register' : 'unregister']), { stdio: 'inherit' });
		p.on('exit', resolve);
		p.on('error', () => resolve(1));
	});
	console.log(code === 0 ? (cmd === 'install' ? '"handide Camera" is installed. Pick it as the camera in any app.' : '"handide Camera" is removed.') : 'Failed.');
	return code;
}
