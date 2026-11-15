#!/usr/bin/env node
// Checks the PC webcam path without a phone or the native parts:
// WebSocket auth, the length-prefixed frames reaching the helper, the "k" acks,
// takeover by a second phone, the waiting-screen marker on disconnect, the
// "not installed" answer, and that the helper stops after the grace period.
//
// The helper is this file itself in helper mode (HANDIDE_CAMERA_HELPER=<this>.mjs).
import http from 'node:http';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const LOG = join(tmpdir(), `handide-check-camera-${process.pid}.log`);

// ---------------------------------------------------------------- helper mode
if (process.argv[2] === 'status') {
	console.log(process.env.FAKE_REGISTERED === '0' ? 'not-registered' : 'registered');
	process.exit(0);
}
if (process.argv[2] === 'run') {
	const log = process.env.FAKE_LOG;
	appendFileSync(log, `start ${process.argv.slice(3).join('x')}\n`);
	let buf = Buffer.alloc(0);
	process.stdin.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		while (buf.length >= 4) {
			const n = buf.readUInt32LE(0);
			if (buf.length < 4 + n) break;
			appendFileSync(log, n === 0 ? 'idle\n' : `frame ${n} ${buf.subarray(4, 4 + n).toString()}\n`);
			buf = buf.subarray(4 + n);
		}
	});
	process.stdin.on('end', () => {
		appendFileSync(log, 'exit\n');
		process.exit(0);
	});
	await new Promise(() => {});
}

// ---------------------------------------------------------------- check mode
process.env.HANDIDE_CAMERA_HELPER = SELF;
process.env.HANDIDE_CAMERA_GRACE_MS = '400';
process.env.FAKE_LOG = LOG;
const { createCamera, CAMERA_WS_PATH } = await import('../proxy/camera.mjs');

const TOKEN = 'test-token';
const camera = createCamera({ token: TOKEN });
const server = http.createServer((req, res) => res.writeHead(404).end());
server.on('upgrade', (req, socket, head) => {
	if (req.url.split('?')[0] === CAMERA_WS_PATH) camera.upgrade(req, socket, head);
	else socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const host = `127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = () => {
	try { return readFileSync(LOG, 'utf8').trim().split('\n'); } catch { return []; }
};

let failed = 0;
const check = (name, ok, extra = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
	if (!ok) failed++;
};

function open({ token = TOKEN, origin = `http://${host}` } = {}) {
	const ws = new WebSocket(`ws://${host}${CAMERA_WS_PATH}`, { headers: { cookie: `vscode-tkn=${token}`, origin } });
	ws.binaryType = 'arraybuffer';
	const msgs = [];
	ws.onmessage = (e) => msgs.push(e.data);
	const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
	const opened = new Promise((r, j) => {
		ws.onopen = () => r(true);
		ws.onerror = () => r(false);
	});
	return { ws, msgs, closed, opened };
}

try {
	// auth
	const bad = open({ token: 'wrong' });
	check('wrong token is refused', !(await bad.opened));
	const cross = open({ origin: 'https://evil.example' });
	check('cross-origin page is refused', !(await cross.opened));

	// frames
	const a = open();
	check('phone connects', await a.opened);
	await sleep(100);
	check('server says ok', a.msgs.some((m) => typeof m === 'string' && JSON.parse(m).ok));
	for (let i = 0; i < 5; i++) a.ws.send(new TextEncoder().encode(`jpeg-${i}`));
	await sleep(300);
	const frames = logLines().filter((l) => l.startsWith('frame'));
	check('helper started at 1280x720@30', logLines()[0] === 'start 1280x720x30', logLines()[0]);
	check('all frames reach the helper in order', frames.length === 5 && frames[4] === 'frame 6 jpeg-4', frames.join(', '));
	check('every frame is acked', a.msgs.filter((m) => m === 'k').length === 5);

	// a big frame (64 KiB+ uses the 8-byte length form)
	const big = new Uint8Array(200_000).fill(65);
	a.ws.send(big);
	await sleep(300);
	check('large frame arrives whole', logLines().some((l) => l.startsWith('frame 200000 ')));

	// takeover
	const b = open();
	await b.opened;
	check('second phone takes over (4000)', (await a.closed) === 4000);
	b.ws.send(new TextEncoder().encode('from-b'));
	await sleep(200);
	check('takeover keeps the same helper', logLines().filter((l) => l.startsWith('start')).length === 1);
	check('frames from the new phone arrive', logLines().includes('frame 6 from-b'));

	// disconnect -> waiting screen, then the helper stops after the grace period
	b.ws.close();
	await sleep(150);
	check('disconnect shows the waiting screen', logLines().includes('idle'));
	await sleep(800);
	check('helper stops after the grace period', logLines().at(-1) === 'exit', logLines().at(-1));

	// not installed
	process.env.FAKE_REGISTERED = '0';
	const c = open();
	await c.opened;
	await c.closed;
	check('not installed is reported to the phone', c.msgs.some((m) => typeof m === 'string' && m.includes('not-registered')));
} finally {
	camera.close();
	server.close();
	rmSync(LOG, { force: true });
}
console.log(failed ? `${failed} failed` : 'camera: all checks passed');
// Let the helper's pipes close before leaving (process.exit during that trips libuv on Windows).
setTimeout(() => process.exit(failed ? 1 : 0), 300);
