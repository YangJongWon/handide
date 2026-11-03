// One phone link for several PCs, whichever of them is on. The page keeps the other PCs'
// links in the cache (mobile.js, on each load and from the PCs menu); when the PC this link
// belongs to does not answer, or answers only with an error, the page load falls back to a
// small page that asks every known PC and opens one whose health check answers.
// A PC that did not answer is not opened, and a later try checks again: falling over to
// one PC once does not keep sending the phone there after that PC goes away.
// Only top-level loads of "/" are touched: everything else goes to the network as usual.
const CACHE = 'handide-fallback';
const DATA = '/__handide/fallback.json';
const TIMEOUT_MS = 15_000;
const PROBE_MS = 8_000;
const AGAIN_MS = 3_000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.mode !== 'navigate' || new URL(req.url).pathname !== '/') return;
	event.respondWith(load(req));
});

// Answers no editor comes from: a refused token (on 2026-10-23 the editor server refused
// every request with 403 while it kept running), and handide or the editor server down
// or starting behind a tunnel that is up (5xx).
const broken = (status) => status === 403 || status >= 500;

async function load(req) {
	let reason;
	try {
		const res = await Promise.race([fetch(req), new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), TIMEOUT_MS))]);
		if (!broken(res.status)) return res;
		reason = res.status;
	} catch {
		reason = null;
	}
	const cached = await caches.open(CACHE).then((c) => c.match(DATA)).catch(() => null);
	const data = cached ? ((await cached.json().catch(() => null)) ?? {}) : {};
	return new Response(page(data.pcs ?? [], data.self ?? null, data.selfName || '', reason), {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	});
}

const TEXT = {
	en: {
		title: 'This PC is not answering',
		broken: 'This PC answered with an error ({1}).',
		looking: 'Checking which PC is on…',
		none: 'No other PCs are known yet. Start handide on this PC, then retry.',
		opening: 'Opening {1}…',
		allOff: 'No PC is answering. Checking again…',
		on: 'on',
		off: 'off',
		retry: 'Check again',
		thisPc: 'This PC',
	},
	ko: {
		title: '이 PC가 응답하지 않습니다',
		broken: '이 PC가 오류로 응답했습니다 ({1}).',
		looking: '어느 PC가 켜져 있는지 확인하는 중…',
		none: '아직 알려진 다른 PC가 없습니다. 이 PC에서 handide를 실행한 뒤 다시 시도하세요.',
		opening: '{1} 여는 중…',
		allOff: '응답하는 PC가 없습니다. 다시 확인하는 중…',
		on: '켜짐',
		off: '꺼짐',
		retry: '다시 확인',
		thisPc: '이 PC',
	},
};
const text = TEXT[(self.navigator.language || 'en').slice(0, 2)] || TEXT.en;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Opens a PC only after its /__handide/health answers 204. An opaque no-cors response is
// not that: a tunnel error page would otherwise count as the PC being on.
function page(pcs, selfLink, selfName, reason) {
	const self = { name: selfName || text.thisPc, link: selfLink || '/', self: true };
	const all = [self, ...pcs.filter((p) => p && p.link)];
	const list = all
		.map((p) => `<li><a href="${esc(p.link)}" data-name="${esc(p.name)}">${esc(p.name)}</a> <small data-for="${esc(p.name)}">…</small></li>`)
		.join('');
	const known = pcs.length || selfLink;
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>handide</title>
<style>body{font:16px/1.5 system-ui,sans-serif;padding:24px;max-width:36em;margin:auto;color-scheme:light dark}a{font-weight:600}small{opacity:.7}</style>
<h1 style="font-size:20px">${esc(text.title)}</h1>
${reason ? `<p>${esc(text.broken.replace('{1}', reason))}</p>` : ''}
<p id="status">${esc(known ? text.looking : text.none)}</p>
<ul>${list}</ul><p><a href="${esc(self.link)}" id="retry">${esc(text.retry)}</a></p>
<script>
const all = ${JSON.stringify(all).replace(/</g, '\\u003c')};
const text = ${JSON.stringify(text).replace(/</g, '\\u003c')};
const reason = ${JSON.stringify(reason)};
const mark = (p, label) => { const el = document.querySelector('small[data-for="' + CSS.escape(p.name) + '"]'); if (el) el.textContent = label; };
const probe = async (p) => {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ${PROBE_MS});
	try {
		const res = await fetch(new URL('/__handide/health', p.link), { cache: 'no-store', signal: ctrl.signal });
		return res.status === 204;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
};
let busy = false;
async function choose() {
	if (busy || !all.length) return;
	busy = true;
	document.getElementById('status').textContent = text.looking;
	const up = [];
	await Promise.all(all.map(async (p) => {
		const ok = await probe(p);
		mark(p, ok ? text.on : text.off);
		if (ok) up.push(p);
	}));
	const selfUp = up.find((p) => p.self);
	const other = up.find((p) => !p.self);
	// A dropped connection can come back: this PC answering again means open it.
	// An error page (403, 5xx) means its editor is not usable, so health alone must not
	// send the phone back there while another PC answers.
	const pick = reason === null && selfUp ? selfUp : other;
	if (pick) {
		document.getElementById('status').textContent = text.opening.replace('{1}', pick.name);
		location.replace(pick.link);
		return;
	}
	document.getElementById('status').textContent = text.allOff;
	busy = false;
	setTimeout(choose, ${AGAIN_MS});
}
for (const link of document.querySelectorAll('ul a')) {
	link.addEventListener('click', async (e) => {
		e.preventDefault();
		const p = all.find((x) => x.name === link.dataset.name);
		if (!p) return;
		mark(p, '…');
		if (await probe(p)) location.assign(p.link);
		else mark(p, text.off);
	});
}
document.getElementById('retry').addEventListener('click', (e) => { e.preventDefault(); busy = false; choose(); });
if (all.length) choose();
</script>`;
}
