// Keeps a page's extension host running while the phone's connection is down.
//
// On Windows the editor server cannot hand a socket to the extension host, so it pipes
// the page's WebSocket into it and the extension host exits the moment that WebSocket
// closes: no reconnection grace at all. A phone browser in the background loses its
// connection within minutes, so every return to the page found Claude Code, Codex, ...
// restarted, and the work they were doing gone (the server log then says "Unknown
// reconnection token (seen before)" a few seconds after "renderer closed the socket").
//
// So the proxy holds the editor server's end of an extension host connection itself:
//
//   page ──ws──> proxy ═══ws (kept open)═══> editor server ──pipe──> extension host
//
// When the page's socket goes, the upstream one stays and the extension host keeps
// working. When the page reconnects (same reconnection token), the editor server still
// answers the reconnection handshake on a new upstream socket; after it, the page is
// joined to the kept one instead, and VS Code's own protocol (message ids, acks, replay)
// catches both sides up: the page is told to resume writing, the extension host to
// resend what the page has not acknowledged.
//
// To splice at message boundaries the proxy reads the WebSocket frames (compression is
// not offered upstream for these connections) and the 13-byte VS Code protocol headers.
// Connections that are not an extension host (management, tunnels) are passed through
// unchanged once their handshake says so.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { killTree, listProcesses } from './editor.mjs';

const HEADER = 13; // type u8, id u32, ack u32, length u32
const MSG = { Control: 2, ReplayRequest: 6, Pause: 7, Resume: 8 };
const EXTENSION_HOST = 2; // desiredConnectionType
const DEFAULT_HOLD_MS = 3 * 60 * 60_000; // what VS Code itself waits elsewhere (ProtocolConstants.ReconnectionGraceTime)

/** Complete WebSocket frames out of a byte stream; `raw` is the frame as received. */
class FrameReader {
	chunks = [];
	length = 0;

	push(chunk) {
		this.chunks.push(chunk);
		this.length += chunk.length;
		const frames = [];
		for (;;) {
			const need = this.#frameLength();
			if (!need || this.length < need) break;
			const buf = this.#take(need);
			frames.push(parseFrame(buf));
		}
		return frames;
	}

	/** Bytes not yet a whole frame. */
	rest() {
		const all = Buffer.concat(this.chunks);
		this.chunks = [];
		this.length = 0;
		return all;
	}

	#peek(n) {
		if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks)];
		return this.chunks[0];
	}

	#frameLength() {
		if (this.length < 2) return 0;
		let b = this.#peek(2);
		const len7 = b[1] & 0x7f;
		const masked = b[1] & 0x80 ? 4 : 0;
		if (len7 < 126) return 2 + masked + len7;
		const ext = len7 === 126 ? 2 : 8;
		if (this.length < 2 + ext) return 0;
		b = this.#peek(2 + ext);
		const len = len7 === 126 ? b.readUInt16BE(2) : Number(b.readBigUInt64BE(2));
		return 2 + ext + masked + len;
	}

	#take(n) {
		const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
		const out = all.subarray(0, n);
		const rest = all.subarray(n);
		this.chunks = rest.length ? [rest] : [];
		this.length = rest.length;
		return out;
	}
}

function parseFrame(raw) {
	let at = 2;
	let len = raw[1] & 0x7f;
	if (len === 126) {
		len = raw.readUInt16BE(2);
		at = 4;
	} else if (len === 127) {
		len = Number(raw.readBigUInt64BE(2));
		at = 10;
	}
	let payload;
	if (raw[1] & 0x80) {
		const mask = raw.subarray(at, at + 4);
		payload = Buffer.from(raw.subarray(at + 4, at + 4 + len));
		for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
	} else payload = raw.subarray(at, at + len);
	return { opcode: raw[0] & 0x0f, rsv: raw[0] & 0x70, payload, raw };
}

/** A binary frame; `mask` for frames sent to the server (clients must mask). */
function frame(payload, mask) {
	const len = payload.length;
	const head = len < 126 ? Buffer.from([0x82, len]) : len < 65536 ? Buffer.from([0x82, 126, len >> 8, len & 0xff]) : Buffer.concat([Buffer.from([0x82, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
	if (!mask) return Buffer.concat([head, payload]);
	head[1] |= 0x80;
	const key = randomBytes(4);
	const body = Buffer.from(payload);
	for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
	return Buffer.concat([head, key, body]);
}

/** A protocol message without data (Pause, Resume, ReplayRequest). */
const bare = (type) => {
	const b = Buffer.alloc(HEADER);
	b[0] = type;
	return b;
};

/** VS Code protocol messages across WebSocket payloads; keeps the data of control messages only. */
class MessageReader {
	header = Buffer.alloc(0);
	inBody = false;
	left = 0;
	type = 0;
	body = null;

	get atBoundary() {
		return !this.inBody && this.header.length === 0;
	}

	push(data) {
		const out = [];
		let i = 0;
		while (i < data.length) {
			if (!this.inBody) {
				const n = Math.min(HEADER - this.header.length, data.length - i);
				this.header = Buffer.concat([this.header, data.subarray(i, i + n)]);
				i += n;
				if (this.header.length < HEADER) break;
				this.type = this.header[0];
				this.left = this.header.readUInt32BE(9);
				this.header = Buffer.alloc(0);
				this.body = this.type === MSG.Control ? [] : null;
				if (this.left === 0) out.push({ type: this.type, body: this.body && Buffer.alloc(0) });
				else this.inBody = true;
			} else {
				const n = Math.min(this.left, data.length - i);
				this.body?.push(data.subarray(i, i + n));
				this.left -= n;
				i += n;
				if (this.left === 0) {
					this.inBody = false;
					out.push({ type: this.type, body: this.body && Buffer.concat(this.body) });
				}
			}
		}
		return out;
	}
}

const controlJson = (m) => {
	try {
		return JSON.parse(m.body.toString('utf8'));
	} catch {
		return null;
	}
};

/** Reads an HTTP response head off the start of a stream; calls back with (head, status, rest). */
function readResponseHead(socket, onHead) {
	let buf = Buffer.alloc(0);
	const onData = (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		const end = buf.indexOf('\r\n\r\n');
		if (end < 0) {
			if (buf.length > 64 * 1024) socket.destroy();
			return;
		}
		socket.off('data', onData);
		const head = buf.subarray(0, end + 4);
		const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head.toString('latin1'))?.[1]);
		onHead(head, status, buf.subarray(end + 4));
	};
	socket.on('data', onData);
}

/**
 * The extension host process of a reconnection token, from the editor server's log
 * ("[<token 8>][ExtensionHostConnection] <pid> Launched Extension Host Process.").
 */
async function extensionHostPid(dataDir, token) {
	const logs = join(dataDir, 'data', 'logs');
	const runs = (await readdir(logs).catch(() => [])).sort().reverse().slice(0, 3);
	const needle = `[${token.slice(0, 8)}][ExtensionHostConnection] <`;
	for (const run of runs) {
		const text = await readFile(join(logs, run, 'remoteagent.log'), 'utf8').catch(() => '');
		const at = text.lastIndexOf(needle);
		if (at < 0) continue;
		const m = /^<(\d+)> Launched/.exec(text.slice(at + needle.length - 1, at + needle.length + 40));
		if (m) return Number(m[1]);
	}
	return null;
}

export function createSessionKeeper({ upstreamPort, dataDir, log, holdMs = Number(process.env.HANDIDE_SESSION_HOLD_MS) || DEFAULT_HOLD_MS }) {
	const sessions = new Map(); // reconnection token -> Session

	/** A socket to the editor server with the page's upgrade request already queued on it. */
	const connectUpstream = (req, headers) => {
		const upstream = net.connect(upstreamPort, '127.0.0.1');
		upstream.setNoDelay(true);
		upstream.write(requestHead(req, headers));
		return upstream;
	};
	const requestHead = (req, headers) => {
		// No compression: frames must be readable to splice, and a kept connection has to
		// work for a page that never negotiated its compression state.
		delete headers['sec-websocket-extensions'];
		const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
		for (const [k, v] of Object.entries(headers)) for (const value of [].concat(v)) lines.push(`${k}: ${value}`);
		return lines.join('\r\n') + '\r\n\r\n';
	};

	class Session {
		constructor(token) {
			this.token = token;
			this.short = token.slice(0, 8);
			this.upstream = null;
			this.client = null;
			this.kept = false; // an extension host connection: kept while the page is away
			this.raw = false; // anything else: passed through unchanged
			this.pid = null;
			this.awaySince = 0;
			this.holdTimer = null;
			this.fromUp = new FrameReader();
			this.upMessages = new MessageReader();
			this.dropUntilBoundary = false;
			this.closed = false;
		}

		// ---- upstream (editor server) side, for the whole life of the session
		start(req, headers, client, head) {
			const up = (this.upstream = connectUpstream(req, headers));
			readResponseHead(up, (respHead, status, rest) => {
				this.client?.write(respHead);
				if (status !== 101) this.raw = true;
				up.on('data', (c) => this.#fromUpstream(c));
				if (rest.length) this.#fromUpstream(rest);
			});
			up.on('error', () => this.close());
			up.on('close', () => this.close());
			this.attach(client, head, { fresh: true });
		}

		#fromUpstream(chunk) {
			if (this.raw) return this.client?.write(chunk);
			for (const f of this.fromUp.push(chunk)) {
				if (f.opcode === 0x8) {
					// The server closed it (the extension host ended): the page sees it too.
					this.client?.write(f.raw);
					return this.close();
				}
				const atBoundary = this.upMessages.atBoundary;
				if (f.opcode === 0x2 || f.opcode === 0x0) this.upMessages.push(f.payload);
				if (!this.client) continue; // away: VS Code resends what was not acknowledged
				if (this.dropUntilBoundary) {
					// Rejoined in the middle of a message: start with the next whole one.
					if (atBoundary && (f.opcode === 0x2 || f.opcode === 0x0)) this.dropUntilBoundary = false;
					else continue;
				}
				this.client.write(f.raw);
			}
		}

		// ---- page side: the first socket, and each one after a reconnection
		attach(client, head, { fresh = false } = {}) {
			if (this.client && this.client !== client) this.client.destroy();
			this.client = client;
			clearTimeout(this.holdTimer);
			if (this.awaySince) log(`extension host session ${this.short} rejoined after ${Math.round((Date.now() - this.awaySince) / 1000)} s away`);
			this.awaySince = 0;
			const frames = new FrameReader();
			const messages = new MessageReader();
			let pending = []; // frames of a message not yet complete
			if (!fresh) {
				// The server paused the page's writing in the reconnection handshake; the
				// extension host, which never saw it, resumes it and resends what is unacknowledged.
				this.dropUntilBoundary = !this.upMessages.atBoundary;
				client.write(frame(bare(MSG.Resume), false));
				this.upstream.write(frame(bare(MSG.ReplayRequest), true));
			}
			const onData = (chunk) => {
				if (this.client !== client) return;
				if (this.raw) return this.upstream.write(chunk);
				for (const f of frames.push(chunk)) {
					if (f.opcode === 0x8 && this.kept) return this.#away(client); // the page closed it: keep the extension host
					if (f.opcode !== 0x2 && f.opcode !== 0x0) {
						this.upstream.write(f.raw);
						continue;
					}
					pending.push(f.raw);
					for (const m of messages.push(f.payload)) {
						if (m.type !== MSG.Control || this.kept || this.raw) continue;
						const control = controlJson(m);
						if (control?.type !== 'connectionType') continue;
						if (control.desiredConnectionType === EXTENSION_HOST) this.kept = true;
						else this.raw = true;
					}
					// Only whole messages go upstream, so a page lost mid-message leaves the
					// extension host's reader at a boundary for the next page socket.
					if (messages.atBoundary) {
						for (const raw of pending) this.upstream.write(raw);
						pending = [];
					}
					if (this.raw) {
						// Not an extension host: from here on, bytes as they come.
						const rest = frames.rest();
						if (rest.length) this.upstream.write(rest);
						const upRest = this.fromUp.rest();
						if (upRest.length) this.client.write(upRest);
						return;
					}
				}
			};
			client.on('data', onData);
			const gone = () => (this.kept ? this.#away(client) : this.close());
			client.on('error', gone);
			client.on('close', gone);
			if (head?.length) onData(head);
		}

		#away(client) {
			if (this.client !== client) return;
			client.destroy();
			this.client = null;
			if (this.closed) return;
			this.awaySince = Date.now();
			log(`page connection of extension host session ${this.short} dropped; keeping the extension host for up to ${Math.round(holdMs / 60_000)} min`);
			extensionHostPid(dataDir, this.token).then((pid) => (this.pid = pid));
			clearTimeout(this.holdTimer);
			this.holdTimer = setTimeout(() => {
				log(`extension host session ${this.short} was away for ${Math.round(holdMs / 60_000)} min; letting it end`);
				this.close();
			}, holdMs);
			this.holdTimer.unref?.();
		}

		close() {
			if (this.closed) return;
			this.closed = true;
			clearTimeout(this.holdTimer);
			this.upstream?.destroy();
			this.client?.destroy();
			this.client = null;
			if (sessions.get(this.token) === this) sessions.delete(this.token);
		}

		/**
		 * A reconnection: the editor server answers the handshake on a new upstream socket
		 * (and pauses the page's writing); after its last message the page is joined to
		 * the kept connection and the new upstream socket is closed.
		 */
		rejoin(req, headers, client, head) {
			if (this.client) {
				// The page gave up on a stalled connection before it closed here.
				this.awaySince ||= Date.now();
				this.client.destroy();
				this.client = null;
			}
			let joined = false;
			const handshake = connectUpstream(req, headers);
			readResponseHead(handshake, (respHead, status, rest) => {
				client.write(respHead);
				if (status !== 101) {
					if (rest.length) client.write(rest);
					handshake.pipe(client);
					return;
				}
				const frames = new FrameReader();
				const messages = new MessageReader();
				let paused = false;
				const onData = (chunk) => {
					for (const f of frames.push(chunk)) {
						if (joined) return;
						client.write(f.raw);
						if (f.opcode !== 0x2 && f.opcode !== 0x0) continue;
						for (const m of messages.push(f.payload)) {
							const control = m.type === MSG.Control ? controlJson(m) : null;
							if (m.type === MSG.Pause) paused = true;
							else if (control?.type === 'error') {
								// The server no longer knows the token: the kept connection is stale.
								log(`extension host session ${this.short} could not be rejoined: ${control.reason}`);
								this.close();
							} else if (m.type === MSG.Control && paused) {
								// The handshake's last message: from here on the page talks to the kept connection.
								joined = true;
								handshake.off('data', onData);
								client.off('data', toHandshake);
								handshake.destroy();
								if (this.closed) client.destroy();
								else this.attach(client, null);
								return;
							}
						}
					}
				};
				handshake.on('data', onData);
				if (rest.length) onData(rest);
			});
			const toHandshake = (chunk) => handshake.write(chunk);
			client.on('data', toHandshake);
			if (head?.length) handshake.write(head);
			const fail = () => {
				if (joined) return;
				handshake.destroy();
				client.destroy();
			};
			handshake.on('error', fail);
			handshake.on('close', fail);
			client.on('error', fail);
			client.on('close', fail);
		}
	}

	/** Handles WebSocket upgrades that carry a reconnection token; false for any other. */
	function upgrade(req, socket, head, headers) {
		const params = new URL(req.url, 'http://x').searchParams;
		const token = params.get('reconnectionToken');
		if (!token) return false;
		socket.setNoDelay(true);
		const kept = sessions.get(token);
		if (params.get('reconnection') === 'true' && kept?.kept && !kept.closed) {
			kept.rejoin(req, headers, socket, head);
			return true;
		}
		const session = new Session(token);
		if (!kept || kept.closed) sessions.set(token, session);
		session.start(req, headers, socket, head);
		return true;
	}

	/** Extension host processes whose page is away (their companions should not take the phone's calls). */
	const awayPids = () => new Set([...sessions.values()].filter((s) => s.kept && !s.client && s.pid).map((s) => s.pid));

	/**
	 * Agents still working in extension hosts whose page is away: what a page opened after
	 * the phone dropped the old one (the browser discarded it) shows, so the work done
	 * meanwhile can be opened there. Claude Code records each running CLI in
	 * ~/.claude/sessions/<pid>.json (session id, status busy/idle/...).
	 */
	let agentCache = { at: 0, value: [] };
	async function awayAgents() {
		const away = [...sessions.values()].filter((s) => s.kept && !s.client && s.pid);
		if (!away.length) return [];
		if (Date.now() - agentCache.at < 4000) return agentCache.value;
		const dir = join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'), 'sessions');
		const records = [];
		for (const name of await readdir(dir).catch(() => [])) {
			if (!/^\d+\.json$/.test(name)) continue;
			const r = await readFile(join(dir, name), 'utf8').then(JSON.parse, () => null);
			if (r?.pid && r.sessionId) records.push(r);
		}
		const procs = records.length ? listProcesses() : [];
		const byPid = new Map(procs.map((p) => [p.pid, p]));
		const hostOf = (pid) => {
			for (let p = byPid.get(pid), hops = 0; p && hops < 4; p = byPid.get(p.ppid), hops++) {
				const s = away.find((x) => x.pid === p.ppid);
				if (s) return s;
			}
			return null;
		};
		const value = [];
		for (const r of records) {
			const s = byPid.has(r.pid) && hostOf(r.pid);
			if (!s) continue;
			value.push({ session: s.short, awaySince: s.awaySince, kind: 'claude', pid: r.pid, sessionId: r.sessionId, name: r.name ?? null, cwd: r.cwd ?? null, status: r.status ?? 'unknown', updatedAt: r.updatedAt ?? null });
		}
		agentCache = { at: Date.now(), value };
		return value;
	}

	/** Ends an away extension host (its work was taken over by the page that asks), and its agents. */
	async function release(short) {
		const s = [...sessions.values()].find((x) => x.short === short && x.kept && !x.client);
		if (!s) return false;
		for (const a of await awayAgents()) if (a.session === short) killTree(a.pid);
		agentCache.at = 0;
		log(`extension host session ${short} released: its work was opened on another page`);
		s.close();
		return true;
	}

	const stats = () => [...sessions.values()].filter((s) => s.kept).map((s) => ({ token: s.short, pid: s.pid, away: !s.client, awaySince: s.awaySince || null }));

	return { upgrade, awayPids, awayAgents, release, stats, close: () => sessions.forEach((s) => s.close()) };
}
