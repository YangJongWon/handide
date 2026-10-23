// One phone link for several PCs, whichever of them is on. The page keeps the other PCs'
// links in the cache (mobile.js, on each load and from the PCs menu); when the PC this link
// belongs to does not answer, or answers only with an error, the page load falls back to a
// small page that opens the first other PC that does.
// Only top-level loads of "/" are touched: everything else goes to the network as usual.
const CACHE = 'handide-fallback';
const DATA = '/__handide/fallback.json';
const TIMEOUT_MS = 15_000;

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
	return new Response(page(data.pcs ?? [], data.self ?? null, reason), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const TEXT = {
	en: { title: 'This PC is not answering', broken: 'This PC answered with an error ({1}).', looking: 'Looking for another PC that is on…', none: 'No other PCs are known yet. Start handide on this PC, then retry.', opening: 'Opening {1}…', allOff: 'No PC is answering. Start handide on one of them, then retry.', on: 'on', off: 'off', retry: 'Retry' },
	ko: { title: '이 PC가 응답하지 않습니다', broken: '이 PC가 오류로 응답했습니다 ({1}).', looking: '켜져 있는 다른 PC를 찾는 중…', none: '아직 알려진 다른 PC가 없습니다. 이 PC에서 handide를 실행한 뒤 다시 시도하세요.', opening: '{1} 여는 중…', allOff: '응답하는 PC가 없습니다. 그중 한 PC에서 handide를 실행한 뒤 다시 시도하세요.', on: '켜짐', off: '꺼짐', retry: '다시 시도' },
};
const text = TEXT[(self.navigator.language || 'en').slice(0, 2)] || TEXT.en;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Retry opens this PC's own link (with its token) when known, so a lost cookie is set again.
function page(pcs, selfLink, reason) {
	const list = pcs.map((p) => `<li><a href="${esc(p.link)}">${esc(p.name)}</a> <small data-name="${esc(p.name)}">…</small></li>`).join('');
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>handide</title>
<style>body{font:16px/1.5 system-ui,sans-serif;padding:24px;max-width:36em;margin:auto;color-scheme:light dark}a{font-weight:600}small{opacity:.7}</style>
<h1 style="font-size:20px">${esc(text.title)}</h1>
${reason ? `<p>${esc(text.broken.replace('{1}', reason))}</p>` : ''}
<p id="status">${esc(pcs.length ? text.looking : text.none)}</p>
<ul>${list}</ul><p><a href="${esc(selfLink || '/')}">${esc(text.retry)}</a></p>
<script>
const pcs = ${JSON.stringify(pcs).replace(/</g, '\\u003c')};
const text = ${JSON.stringify(text).replace(/</g, '\\u003c')};
// A cross-origin request that completes (opaque answer) means handide is on there.
const probe = (p) => Promise.race([
	fetch(new URL('/__handide/health', p.link), { mode: 'no-cors', cache: 'no-store' }).then(() => p),
	new Promise((_, fail) => setTimeout(fail, 8000)),
]);
const mark = (p, text) => { const el = document.querySelector('small[data-name="' + CSS.escape(p.name) + '"]'); if (el) el.textContent = text; };
if (pcs.length) {
	for (const p of pcs) probe(p).then(() => mark(p, text.on), () => mark(p, text.off));
	Promise.any(pcs.map(probe)).then(
		(p) => { document.getElementById('status').textContent = text.opening.replace('{1}', p.name); location.replace(p.link); },
		() => { document.getElementById('status').textContent = text.allOff; },
	);
}
</script>`;
}
