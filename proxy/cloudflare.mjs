// Access from anywhere with no account: a Cloudflare Quick Tunnel publishes handide at a
// random https://<words>.trycloudflare.com (real certificate, the phone needs nothing).
// The address changes on every run and anyone with it reaches the page, so the access
// token is what guards it. cloudflared is used from PATH or downloaded once into the
// handide home (official release from GitHub, no admin rights needed).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const LAYER_PROBE = '/__handide/mobile.css'; // served without the token, so it shows the tunnel is through

function releaseAsset() {
	const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch] || 'amd64';
	if (process.platform === 'win32') return { file: `cloudflared-windows-${arch === '386' ? '386' : 'amd64'}.exe` };
	if (process.platform === 'darwin') return { file: `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`, tgz: true };
	return { file: `cloudflared-linux-${arch}` };
}

function works(bin) {
	try {
		execFileSync(bin, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
		return true;
	} catch {
		return false;
	}
}

async function ensureCloudflared(dataDir, log) {
	const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
	const local = join(dataDir, 'bin', exe);
	const candidates = ['cloudflared', local, ...(process.platform === 'win32' ? ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe'] : [])];
	for (const c of candidates) if ((c === 'cloudflared' || existsSync(c)) && works(c)) return c;

	const asset = releaseAsset();
	log(`Cloudflare: downloading cloudflared (${asset.file}, once)...`);
	const res = await fetch(RELEASE + asset.file);
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
	await mkdir(join(dataDir, 'bin'), { recursive: true });
	const body = Buffer.from(await res.arrayBuffer());
	if (asset.tgz) {
		const tgz = join(dataDir, 'bin', asset.file);
		await writeFile(tgz, body);
		execFileSync('tar', ['-xzf', tgz, '-C', join(dataDir, 'bin')]);
		await rm(tgz, { force: true });
	} else {
		await writeFile(local, body);
	}
	await chmod(local, 0o755);
	if (!works(local)) throw new Error('downloaded cloudflared does not run');
	return local;
}

/** Starts a Quick Tunnel to 127.0.0.1:<port>. Resolves to { url, stop } or { reason }. */
export async function startCloudflare({ port, tls, dataDir, log }) {
	let bin;
	try {
		bin = await ensureCloudflared(dataDir, log);
	} catch (err) {
		return { reason: `cloudflared unavailable: ${err.message}` };
	}
	const target = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
	const args = ['tunnel', '--no-autoupdate', '--url', target, ...(tls ? ['--no-tls-verify'] : [])];
	// A private home: an existing ~/.cloudflared (config.yaml or named-tunnel credentials)
	// silently breaks Quick Tunnels, which then answer 404 at the edge.
	const home = join(dataDir, 'cloudflared-home');
	await mkdir(home, { recursive: true });
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	for (const k of Object.keys(env)) if (k.startsWith('TUNNEL_')) delete env[k];
	const child = spawn(bin, args, { windowsHide: true, cwd: home, env });
	const stop = () => {
		if (child.exitCode === null) child.kill();
	};
	const started = await new Promise((resolve) => {
		let out = '';
		const timer = setTimeout(() => {
			stop();
			resolve({ reason: 'cloudflared timed out', hint: out.trim().split('\n').slice(-2).join(' ') });
		}, 60000);
		const onData = (d) => {
			out += d;
			const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
			if (m) {
				clearTimeout(timer);
				resolve({ url: m[0], stop });
			}
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ reason: `cloudflared exited (${code})`, hint: out.trim().split('\n').slice(-2).join(' ') });
		});
	});
	if (!started.url) return started;

	// The new hostname needs a few seconds in DNS; a phone scanning earlier would cache the failure.
	for (let i = 0; i < 20; i++) {
		try {
			const res = await fetch(`${started.url}${LAYER_PROBE}`, { signal: AbortSignal.timeout(5000) });
			if (res.ok) break;
		} catch {
			// not resolvable yet
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	return started;
}
