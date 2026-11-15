// Web Push to the phone (a home-screen handide on iPhone, or Chrome/Android), with no
// dependency: VAPID (RFC 8292) signs with this handide's own P-256 key, and the message
// is encrypted for the phone's subscription (RFC 8291, aes128gcm). Keys and the phones'
// subscriptions live in <data dir>/push.json.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN_COOKIE = 'vscode-tkn';
const PREFIX = '/__handide/push/';
const SUBJECT = 'mailto:handide@users.noreply.github.com';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

const cookies = (req) => {
	const out = {};
	for (const part of (req.headers.cookie || '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k) out[k] = v.join('=');
	}
	return out;
};

/** RFC 8291: the body for one subscription. */
export function encrypt(payload, keys, fixed = null) {
	const uaPublic = unb64u(keys.p256dh);
	const authSecret = unb64u(keys.auth);
	const ecdh = crypto.createECDH('prime256v1');
	// `fixed` (the sender's key and the salt) only for checking against RFC 8291's example.
	if (fixed) ecdh.setPrivateKey(unb64u(fixed.asPrivate));
	const asPublic = fixed ? ecdh.getPublicKey() : ecdh.generateKeys();
	const shared = ecdh.computeSecret(uaPublic);
	const salt = fixed ? unb64u(fixed.salt) : crypto.randomBytes(16);
	const prkKey = hmac(authSecret, shared);
	const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])])).subarray(0, 32);
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
	const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
	const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(4096, 16);
	header[20] = asPublic.length;
	return Buffer.concat([header, asPublic, sealed]);
}

export function createPush({ dataDir, token, log }) {
	const file = join(dataDir, 'push.json');
	let state;
	try {
		state = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		state = null;
	}
	if (!state?.publicKey || !state?.privateKey) {
		const ecdh = crypto.createECDH('prime256v1');
		ecdh.generateKeys();
		state = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), subs: [] };
	}
	state.subs ??= [];
	const save = () => {
		try {
			writeFileSync(file, JSON.stringify(state, null, '\t'), { mode: 0o600 });
		} catch (err) {
			log(`push: cannot save ${file}: ${err.message}`);
		}
	};
	save();

	const pub = unb64u(state.publicKey);
	const signingKey = crypto.createPrivateKey({
		key: { kty: 'EC', crv: 'P-256', d: state.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
		format: 'jwk',
	});

	function vapid(endpoint) {
		const aud = new URL(endpoint).origin;
		const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
		const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
		const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey, dsaEncoding: 'ieee-p1363' });
		return `vapid t=${head}.${body}.${b64u(sig)}, k=${state.publicKey}`;
	}

	/** Sends to one subscription; a subscription the push service no longer knows is dropped. */
	async function sendTo(sub, message) {
		const res = await fetch(sub.endpoint, {
			method: 'POST',
			headers: {
				authorization: vapid(sub.endpoint),
				'content-encoding': 'aes128gcm',
				'content-type': 'application/octet-stream',
				ttl: '86400',
				urgency: 'high',
			},
			body: encrypt(JSON.stringify(message), sub.keys),
		});
		if (res.status === 404 || res.status === 410) {
			state.subs = state.subs.filter((s) => s.endpoint !== sub.endpoint);
			save();
			log('push: a phone unsubscribed (gone at its push service)');
		} else if (!res.ok) log(`push: ${new URL(sub.endpoint).host} answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
		return res.ok;
	}

	/** `make(lang)` gives the message in each phone's language: { title, body, url, tag }. */
	async function send(make) {
		const results = await Promise.all(state.subs.map((s) => sendTo(s, make(s.lang || 'en')).catch((err) => (log(`push: ${err.message}`), false))));
		return results.filter(Boolean).length;
	}

	const sendJson = (res, status, body) => {
		res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(body));
	};
	const readBody = (req) =>
		new Promise((resolve) => {
			let data = '';
			req.on('data', (c) => (data.length < 16384 ? (data += c) : req.destroy()));
			req.on('end', () => {
				try {
					resolve(JSON.parse(data || '{}'));
				} catch {
					resolve({});
				}
			});
		});

	/** /__handide/push/{key,subscribe,unsubscribe}: only with the access token's cookie. */
	function handle(req, res) {
		const pathname = req.url.split('?')[0];
		if (!pathname.startsWith(PREFIX)) return false;
		if (cookies(req)[TOKEN_COOKIE] !== token) return sendJson(res, 403, { ok: false }), true;
		const what = pathname.slice(PREFIX.length);
		if (what === 'key') return sendJson(res, 200, { ok: true, key: state.publicKey }), true;
		if (req.method !== 'POST' || !['subscribe', 'unsubscribe'].includes(what)) return sendJson(res, 404, { ok: false }), true;
		readBody(req).then(async (body) => {
			const sub = body.subscription;
			if (what === 'unsubscribe') {
				state.subs = state.subs.filter((s) => s.endpoint !== body.endpoint);
				save();
				return sendJson(res, 200, { ok: true });
			}
			if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return sendJson(res, 400, { ok: false, error: 'bad subscription' });
			const lang = String(body.lang || 'en').slice(0, 2);
			state.subs = [...state.subs.filter((s) => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, lang, at: Date.now() }].slice(-10);
			save();
			log(`push: a phone subscribed (${new URL(sub.endpoint).host})`);
			const welcome = { ko: '알림이 켜졌습니다', en: 'Notifications are on', ja: '通知がオンになりました', zh: '通知已开启' };
			const sent = await sendTo(state.subs.at(-1), { title: 'handide', body: welcome[lang] || welcome.en, tag: 'handide-welcome', url: '/' }).catch(() => false);
			sendJson(res, 200, { ok: true, sent });
		});
		return true;
	}

	return {
		handle,
		send,
		get subscribed() {
			return state.subs.length > 0;
		},
	};
}
