#!/usr/bin/env node
// One phone, one extension host (proxy/sessions.mjs, PHONE_COOKIE): a stand-in editor
// server and raw WebSocket pages that announce an extension host connection.
//   - the same phone opening a new page ends its old, away extension host
//   - another phone's, and a page without the phone cookie, are kept as before
//   - a tab of the same phone still connected is not cut off; it ends once it goes away
//   - the workbench gives a phone without one an id cookie (phoneCookie)
// The pages leave by dropping TCP without a close frame, as a killed tab does: before
// sessions.mjs listened for 'end', such a page counted as connected forever.
//   - one with a Claude agent still working is not ended: the same phone's page sees it as
//     `mine` (it asks: take over now or when done), another phone's does not; taking it
//     over now (release) ends it
// Not covered here: the 2-minute handover of a done agent, the page's dialog itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionKeeper, phoneCookie, phoneOf, strayWork } from '../proxy/sessions.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Editor server: accepts every upgrade and keeps the socket open (an extension host).
const upstreamSockets = new Set();
const editor = net.createServer((s) => {
	upstreamSockets.add(s);
	s.once('data', () => s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
	s.on('close', () => upstreamSockets.delete(s));
	s.on('error', () => {});
});
await new Promise((r) => editor.listen(0, '127.0.0.1', r));

const logs = [];
const dataDir = mkdtempSync(join(tmpdir(), 'hd-sessions-'));
// A Claude agent at work: a stand-in extension host process with a child as the CLI,
// recorded the way the editor server (remoteagent.log) and Claude Code (sessions/) do.
const AGENT_TOKEN = 'agentses-0000-session';
const host = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e6)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1e6)"], { stdio: ['ignore', 'pipe', 'ignore'] });
const cliPid = Number(await new Promise((r) => host.stdout.once('data', (d) => r(String(d).trim()))));
mkdirSync(join(dataDir, 'data', 'logs', '20261118T000000'), { recursive: true });
writeFileSync(join(dataDir, 'data', 'logs', '20261118T000000', 'remoteagent.log'), `[${AGENT_TOKEN.slice(0, 8)}][ExtensionHostConnection] <${host.pid}> Launched Extension Host Process.\n`);
const claudeDir = join(dataDir, 'claude');
mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
writeFileSync(join(claudeDir, 'sessions', `${cliPid}.json`), JSON.stringify({ pid: cliPid, sessionId: 'conv-1', status: 'busy' }));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const keeper = createSessionKeeper({ upstreamPort: editor.address().port, dataDir, log: (l) => logs.push(l) });
const server = http.createServer();
server.on('upgrade', (req, socket, head) => {
	if (!keeper.upgrade(req, socket, head, { ...req.headers })) socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

/** A masked client frame carrying the VS Code control message "connectionType: extension host". */
function extensionHostHello() {
	const json = Buffer.from(JSON.stringify({ type: 'connectionType', desiredConnectionType: 2 }));
	const msg = Buffer.alloc(13 + json.length);
	msg[0] = 2; // Control
	msg.writeUInt32BE(json.length, 9);
	json.copy(msg, 13);
	const key = Buffer.from([1, 2, 3, 4]);
	const body = Buffer.from(msg);
	for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
	return Buffer.concat([Buffer.from([0x82, 0x80 | body.length]), key, body]);
}

let n = 0;
async function openPage(phone, token = `tok${String(++n).padStart(5, '0')}-session`) {
	const s = net.connect(server.address().port, '127.0.0.1');
	await new Promise((r) => s.once('connect', r));
	s.on('error', () => {});
	s.write(`GET /stable-x?reconnectionToken=${token}&reconnection=false HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${phone ? `Cookie: a=b; __handide_phone=${phone}\r\n` : ''}\r\n`);
	await new Promise((r) => s.once('data', r)); // 101
	s.write(extensionHostHello());
	await sleep(100);
	return { token: token.slice(0, 8), socket: s, leave: async () => { s.destroy(); await sleep(150); } };
}
const kept = () => keeper.stats().map((x) => x.token).sort();

const A = 'phoneAAAAAAAAAAAAAAAAAAAA';
const B = 'phoneBBBBBBBBBBBBBBBBBBBB';
try {
	const a1 = await openPage(A);
	await a1.leave(); // the browser dropped it: kept, as before
	assert.deepEqual(kept(), [a1.token]);
	const b1 = await openPage(B);
	await b1.leave();
	const none1 = await openPage(null);
	await none1.leave();
	assert.deepEqual(kept(), [a1.token, b1.token, none1.token].sort(), 'away sessions of different phones are all kept');

	const a2 = await openPage(A); // the same phone opens a new page
	await sleep(300);
	assert.deepEqual(kept(), [a2.token, b1.token, none1.token].sort(), "phone A's old extension host ends when it opens a new page");
	assert.ok(logs.some((l) => l.includes(`${a1.token} ended: this phone opened a newer page`)), logs.join('\n'));
	console.log('PASS: a new page of the same phone ends its old away extension host; other phones and cookie-less pages keep theirs');

	const a3 = await openPage(A); // a second tab while a2 is still connected
	await sleep(300);
	assert.ok(kept().includes(a2.token), 'a connected tab of the same phone is not cut off');
	await a2.leave(); // now it goes away: newer exists, so it ends instead of being held
	await sleep(300);
	assert.ok(!kept().includes(a2.token), 'the older tab ends once it goes away');
	assert.ok(kept().includes(a3.token));
	console.log('PASS: an older tab still connected stays until it goes away, then ends at once');

	const none2 = await openPage(null);
	await sleep(300);
	assert.ok(kept().includes(none1.token), 'pages without the cookie are never matched to each other');
	none2.socket.destroy();
	a3.socket.destroy();

	const C = 'phoneCCCCCCCCCCCCCCCCCCCC';
	const c1 = await openPage(C, AGENT_TOKEN); // its Claude agent is working
	await c1.leave();
	await sleep(300);
	const c2 = await openPage(C);
	await sleep(1500);
	assert.ok(kept().includes(c1.token), 'an extension host whose agent is working is not ended without a choice');
	const forC = (await keeper.awayAgents(C)).find((a) => a.session === c1.token);
	assert.equal(forC?.status, 'busy', JSON.stringify(forC));
	assert.equal(forC.mine, true, "the same phone's new page is offered to take it over");
	assert.equal((await keeper.awayAgents(B)).find((a) => a.session === c1.token)?.mine, false, "another phone's page is not");
	assert.ok(logs.some((l) => l.includes(`${c1.token} replaced by a newer page; its agent is working`)), logs.join('\n'));
	assert.equal(await keeper.release(c1.token), true); // "Take over now"
	assert.ok(!kept().includes(c1.token), 'taking it over now ends the old extension host');
	c2.socket.destroy();
	console.log('PASS: a working agent waits for the choice (mine for the same phone only); taking it over now ends the old one');

	// Left-over work: a nohup'd training run counts, Edge's startup boost and Windows' own do not.
	{
		const ft = (ms) => (ms + 11644473600000) * 1e4;
		const at = Date.now();
		const procs = [
			{ pid: 101, ppid: 9999, start: ft(at), cmd: 'nohup python train.py' },
			{ pid: 102, ppid: 101, start: ft(at + 5), cmd: 'python.exe train.py --epochs 10' },
			...[201, 202, 203].map((pid) => ({ pid, ppid: 9998, start: ft(at), cmd: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --no-startup-window /prefetch:5' })),
			{ pid: 204, ppid: 9997, start: ft(at), cmd: '"C:\\Users\\x\\AppData\\Local\\Naver\\Naver Whale\\Application\\whale.exe" --type=renderer' },
			{ pid: 205, ppid: 9996, start: ft(at), cmd: 'C:\\Windows\\system32\\svchost.exe -k netsvcs' },
			{ pid: 206, ppid: 9995, start: ft(at), cmd: 'C:\\Windows\\system32\\OpenWith.exe -Embedding' },
		];
		const found = strayWork(procs, at - 1000, at + 1000);
		assert.deepEqual(found.map((w) => w.pid), [102], JSON.stringify(found));
		console.log('PASS: left-over work is the training run, not browsers or Windows processes');
	}

	const fresh = phoneCookie({ headers: {} }, true);
	assert.match(fresh, /^__handide_phone=[A-Za-z0-9_-]{24}; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure$/);
	const id = fresh.split(';')[0].split('=')[1];
	assert.equal(phoneOf({ headers: { cookie: `x=1; __handide_phone=${id}` } }), id);
	assert.equal(phoneCookie({ headers: { cookie: `__handide_phone=${id}` } }, true), null, 'no new id for a phone that has one');
	assert.equal(phoneOf({ headers: { cookie: '__handide_phone=bad id!' } }), null);
	assert.ok(!phoneCookie({ headers: {} }, false).includes('Secure'));
	console.log('PASS: phone id cookie (set once, read back, malformed ignored)');
} finally {
	keeper.close();
	server.close();
	editor.close();
	for (const s of upstreamSockets) s.destroy();
	try { process.kill(cliPid); } catch {}
	host.kill();
}
