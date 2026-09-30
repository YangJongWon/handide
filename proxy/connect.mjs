// Connection info shared by the terminal output and the PC-side connect page
// (http://localhost:<port>/__handide/connect), which shows the QR code large.
import QRCode from 'qrcode';
import { lanAddresses } from './tls.mjs';

/** Where a phone can reach this handide, best address first. */
export function accessInfo({ host, port, token, tls }) {
	const scheme = tls ? 'https' : 'http';
	const path = `/?tkn=${encodeURIComponent(token)}`;
	const local = host === '127.0.0.1' || host === 'localhost';
	const links = local
		? []
		: lanAddresses().map((a) => ({ url: `${scheme}://${a.ip}:${port}${path}`, label: a.tailscale ? 'Tailscale' : a.name }));
	return { local, scheme, port, localUrl: `${scheme}://localhost:${port}${path}`, links };
}

/**
 * The connect page reveals the access token, so it is only served to this PC:
 * a loopback connection AND a localhost Host header (the latter blocks DNS
 * rebinding, where a web page in the PC's browser points its own name at 127.0.0.1).
 */
export function isConnectAllowed(req) {
	const addr = req.socket.remoteAddress || '';
	const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
	const host = (req.headers.host || '').toLowerCase();
	const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
	return loopback && localHost;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function renderConnectPage(info, { selfSigned } = {}) {
	const targets = info.links.length ? info.links : [];
	const qrs = await Promise.all(
		targets.map((t) => QRCode.toString(t.url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } })),
	);
	const tabs = targets
		.map((t, i) => `<button type="button" role="tab" data-i="${i}" aria-selected="${i === 0}">${escapeHtml(t.label)} · ${escapeHtml(new URL(t.url).hostname)}</button>`)
		.join('');
	const panels = targets
		.map(
			(t, i) => `<section class="panel" data-i="${i}"${i ? ' hidden' : ''}>
				<div class="qr" role="img" aria-label="QR code for ${escapeHtml(new URL(t.url).origin)}">${qrs[i]}</div>
				<div class="link"><code>${escapeHtml(t.url)}</code><button type="button" class="copy" data-url="${escapeHtml(t.url)}">복사</button></div>
			</section>`,
		)
		.join('');

	const body = info.local
		? `<h1>이 PC 전용으로 실행 중</h1>
			<p class="lead"><code>--local</code>로 실행해서 LAN 주소와 QR이 없습니다. 폰에서 쓰려면 <code>--local</code> 없이 다시 실행하세요.</p>
			<div class="link"><code>${escapeHtml(info.localUrl)}</code><button type="button" class="copy" data-url="${escapeHtml(info.localUrl)}">복사</button></div>
			<p class="note">Android를 USB로 연결했다면 <code>adb reverse tcp:${info.port} tcp:${info.port}</code> 후 폰에서 위 주소를 열면 됩니다.</p>`
		: !targets.length
			? `<h1>LAN 주소를 찾지 못했습니다</h1>
			<p class="lead">PC가 Wi-Fi나 유선 네트워크에 연결돼 있는지 확인한 뒤 handide를 다시 실행하세요.</p>`
			: `<h1>폰 카메라로 QR을 찍으세요</h1>
			<p class="lead">폰과 이 PC가 같은 Wi-Fi에 있어야 합니다.</p>
			${targets.length > 1 ? `<div class="tabs" role="tablist">${tabs}</div>` : ''}
			${panels}
			<ol class="steps">
				${selfSigned ? `<li><b>처음 한 번 인증서 경고</b>가 뜹니다. 이 PC가 직접 만든 인증서라서입니다.<br>Android 크롬: <i>고급</i> → <i>계속</i> · iPhone Safari: <i>세부사항 보기</i> → <i>이 웹사이트 방문</i></li>` : ''}
				<li>VS Code가 폴더를 <b>신뢰</b>할지 물으면 신뢰를 누르세요. 그래야 모바일 탭과 에이전트 확장이 동작합니다.</li>
				<li>연결이 안 되면 Windows 방화벽이 포트 ${info.port}를 막고 있는지 확인하세요.</li>
			</ol>
			<p class="note">링크에 접속 토큰이 들어 있습니다. 비밀번호처럼 본인 기기에만 쓰세요.${selfSigned ? ` 인증서 SHA-1: <code>${escapeHtml(selfSigned)}</code>` : ''}</p>`;

	return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>handide 연결</title>
<style>
	:root { --bg: #f6f7f9; --card: #ffffff; --fg: #1d2129; --muted: #5b6270; --line: #dfe3ea; --accent: #0b64d8; }
	@media (prefers-color-scheme: dark) { :root { --bg: #15171b; --card: #1e2127; --fg: #e8eaee; --muted: #a2a9b6; --line: #333844; --accent: #5aa2ff; } }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; word-break: keep-all; }
	main { max-width: 560px; margin: 0 auto; padding: 40px 16px 56px; }
	.brand { font-weight: 600; color: var(--muted); letter-spacing: .02em; margin: 0 0 20px; }
	h1 { font-size: 26px; line-height: 1.25; margin: 0 0 6px; }
	.lead { color: var(--muted); margin: 0 0 24px; }
	.tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
	.tabs button { border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 14px; cursor: pointer; }
	.tabs button[aria-selected="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
	.qr { background: #fff; border-radius: 16px; padding: 16px; width: min(100%, 420px); margin: 0 auto 16px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
	.qr svg { display: block; width: 100%; height: auto; }
	.link { display: flex; gap: 8px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 24px; }
	.link code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
	.copy { flex: none; border: 0; background: var(--accent); color: #fff; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 14px; cursor: pointer; }
	.steps { padding-left: 20px; margin: 0 0 20px; }
	.steps li { margin-bottom: 10px; }
	.note { color: var(--muted); font-size: 14px; }
	code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
</style>
</head>
<body>
<main>
	<p class="brand">handide</p>
	${body}
</main>
<script>
	for (const b of document.querySelectorAll('.tabs button')) {
		b.addEventListener('click', () => {
			for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t === b));
			for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.i !== b.dataset.i;
		});
	}
	for (const c of document.querySelectorAll('.copy')) {
		c.addEventListener('click', async () => {
			try { await navigator.clipboard.writeText(c.dataset.url); c.textContent = '복사됨'; }
			catch { c.textContent = '복사 실패'; }
			setTimeout(() => (c.textContent = '복사'), 1500);
		});
	}
</script>
</body>
</html>`;
}
