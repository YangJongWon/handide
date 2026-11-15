// The phone as the PC's webcam: this screen streams the phone's camera to handide on
// the PC, which feeds the "handide Camera" virtual webcam (proxy/camera.mjs).
//
// JPEG frames over a WebSocket on the connection the editor already uses (https, so
// the browser allows the camera). The server answers each frame with "k"; at most two
// are in flight, so a slow link drops the frame rate instead of piling up delay.
// Loaded on demand by layer/mobile.js.

const MAX_SIDE = 1280; // the PC camera is 1280x720; the PC letterboxes portrait frames
const QUALITY = 0.72;
const IN_FLIGHT = 2;

let open = null; // the running screen, so a second tap does not start another

/** openCamera({ t, icon, el }) — t: i18n, el/icon: the layer's DOM helpers. */
export function openCamera({ t, icon, el }) {
	if (open) return;
	const video = el('video', { playsinline: '', muted: '', autoplay: '' });
	video.muted = true;
	const status = el('div', { class: 'hd-cam-status' }, t('camera.connecting'));
	const btn = (name, label, onclick) => el('button', { type: 'button', class: 'hd-icon-btn', 'aria-label': t(label), onclick }, icon(name));
	const root = el(
		'div',
		{ id: 'hd-cam', role: 'dialog', 'aria-label': t('camera.title') },
		video,
		el('div', { class: 'hd-cam-bar' }, el('strong', {}, t('camera.title')), status),
		el('div', { class: 'hd-cam-actions' }, btn('arrow-swap', 'camera.switch', () => switchCamera()), btn('close', 'camera.stop', () => close())),
	);
	document.body.append(root);

	let facing = 'environment';
	let stream = null;
	let ws = null;
	let wake = null;
	let inFlight = 0;
	let acked = 0;
	let fps = 0;
	let timer = 0;
	let fpsTimer = 0;
	let closed = false;
	let retry = 0;
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');

	const say = (key, ...args) => {
		status.textContent = t(key, ...args);
		status.dataset.state = key;
	};

	async function startVideo() {
		stream?.getTracks().forEach((tr) => tr.stop());
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
				audio: false,
			});
		} catch (err) {
			say(err?.name === 'NotAllowedError' ? 'camera.denied' : 'camera.noCamera');
			return false;
		}
		video.srcObject = stream;
		video.classList.toggle('hd-cam-mirror', facing === 'user');
		await video.play().catch(() => {});
		return true;
	}

	function connect() {
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		ws = new WebSocket(`${proto}://${location.host}/__handide/camera/ws`);
		ws.binaryType = 'arraybuffer';
		inFlight = 0;
		ws.onmessage = (e) => {
			if (e.data === 'k') {
				inFlight = Math.max(0, inFlight - 1);
				acked++;
				return;
			}
			let msg;
			try { msg = JSON.parse(e.data); } catch { return; }
			if (msg.error) {
				closed = true; // nothing to retry: the PC side is not set up
				say(msg.error === 'not-registered' ? 'camera.notInstalled' : msg.error === 'unsupported' ? 'camera.unsupported' : 'camera.missing');
				return;
			}
			retry = 0;
			say('camera.live', 0);
			pump();
		};
		ws.onclose = (e) => {
			clearTimeout(timer);
			if (closed) return;
			if (e.code === 4000) return say('camera.replaced');
			say('camera.lost');
			// The connection comes back on its own (network change, PC restart).
			setTimeout(() => !closed && connect(), Math.min(10_000, 1000 * 2 ** retry++));
		};
	}

	function pump() {
		clearTimeout(timer);
		if (closed || ws?.readyState !== WebSocket.OPEN) return;
		const w = video.videoWidth, h = video.videoHeight;
		if (w && h && inFlight < IN_FLIGHT && ws.bufferedAmount < 1 << 20 && !document.hidden) {
			const k = Math.min(1, MAX_SIDE / Math.max(w, h));
			canvas.width = Math.round(w * k);
			canvas.height = Math.round(h * k);
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			inFlight++;
			canvas.toBlob((blob) => {
				if (blob && ws?.readyState === WebSocket.OPEN) ws.send(blob);
				else inFlight = Math.max(0, inFlight - 1);
			}, 'image/jpeg', QUALITY);
		}
		timer = setTimeout(pump, 1000 / 30);
	}

	async function switchCamera() {
		facing = facing === 'environment' ? 'user' : 'environment';
		await startVideo();
	}

	async function keepAwake() {
		try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
	}

	// Phones stop the camera in the background; start it again when the page is back.
	const onVisible = async () => {
		if (document.hidden || closed) return;
		if (!stream || stream.getVideoTracks().every((tr) => tr.readyState === 'ended')) await startVideo();
		keepAwake();
	};

	function close() {
		closed = true;
		clearTimeout(timer);
		clearInterval(fpsTimer);
		document.removeEventListener('visibilitychange', onVisible);
		stream?.getTracks().forEach((tr) => tr.stop());
		try { ws?.close(1000); } catch { /* already closed */ }
		wake?.release?.().catch(() => {});
		root.remove();
		open = null;
	}

	open = { close };
	document.addEventListener('visibilitychange', onVisible);
	fpsTimer = setInterval(() => {
		fps = acked;
		acked = 0;
		if (status.dataset.state === 'camera.live') say('camera.live', fps);
	}, 1000);
	keepAwake();
	startVideo().then((ok) => ok && connect());
}
