// Access from anywhere through Tailscale at a fixed https://<machine>.<tailnet>.ts.net with
// a real certificate: "tailscale funnel" (public, the phone needs nothing) or "tailscale
// serve" (only devices signed in to the tailnet). Both forward the original Host header and
// set X-Forwarded-Proto, so the proxy's host rewriting keeps working unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATES = {
	win32: ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'],
	darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
};

function run(cli, args, { timeout = 15000, onOutput } = {}) {
	return new Promise((resolve) => {
		let out = '';
		let child;
		try {
			child = spawn(cli, args, { windowsHide: true });
		} catch (err) {
			resolve({ code: -1, out: err.message });
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			resolve({ code: null, out, timedOut: true });
		}, timeout);
		const collect = (d) => {
			out += d;
			onOutput?.(out);
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ code: -1, out: err.message });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, out });
		});
	});
}

async function findCli() {
	for (const p of CANDIDATES[process.platform] || []) if (existsSync(p)) return p;
	const probe = await run('tailscale', ['version'], { timeout: 5000 });
	return probe.code === 0 ? 'tailscale' : null;
}

export const PHONE_APP_URL = 'https://tailscale.com/download';

export function openBrowser(url) {
	const [cmd, args] =
		process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
		: process.platform === 'darwin' ? ['open', [url]]
		: ['xdg-open', [url]];
	try {
		spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
	} catch {
		// the link is printed as well
	}
}

/** Runs a Tailscale command that may stop for a browser step; opens that page once. */
function runWithBrowserStep(cli, args, { log, what, timeout = 600000 }) {
	let opened = false;
	return run(cli, args, {
		timeout,
		onOutput: (out) => {
			const link = out.match(/https:\/\/login\.tailscale\.com\/\S+/);
			if (link && !opened) {
				opened = true;
				log(`Tailscale: ${what} in the browser that just opened (or open ${link[0]})`);
				openBrowser(link[0]);
			}
		},
	});
}

async function readStatus(cli) {
	const status = await run(cli, ['status', '--json']);
	try {
		const json = JSON.parse(status.out);
		return { state: json.BackendState, dnsName: json.Self?.DNSName?.replace(/\.$/, '') };
	} catch {
		return { state: 'NoState' };
	}
}

async function publish(cli, verb, target, log) {
	// First use: serve waits until HTTPS is allowed for the tailnet, funnel until Funnel is.
	const what = verb === 'funnel' ? 'allow public access (Funnel) for this PC (once)' : 'allow HTTPS for your tailnet (once)';
	const res = await runWithBrowserStep(cli, [verb, '--bg', '--yes', '--https=443', target], { log, what });
	if (res.code === 0) return { stop: () => spawnSync(cli, [verb, '--https=443', 'off'], { windowsHide: true, timeout: 5000 }) };
	const hint = res.out.trim().split('\n').slice(-2).join(' ');
	return { reason: res.timedOut ? `tailscale ${verb} timed out` : `tailscale ${verb} failed`, hint };
}

/**
 * Publishes http(s)://127.0.0.1:<port> at https://<machine>.<tailnet>.ts.net.
 * Public (Funnel: any browser, the access token guards it) unless `private`, then only
 * devices signed in to the tailnet (Serve). Falls back to Serve when Funnel is not allowed.
 * Resolves to { url, public, stop } on success, or { reason, hint? }.
 */
export async function startTailscale({ port, tls, log, private: tailnetOnly }) {
	const cli = await findCli();
	if (!cli) return { reason: 'not installed' };
	const { state, dnsName } = await readStatus(cli);
	if (state !== 'Running' || !dnsName) return { reason: state === 'NeedsLogin' ? 'signed out, run "handide remote"' : `state ${state || 'unknown'}` };

	// The LAN port speaks TLS with a self-signed certificate, hence https+insecure.
	const target = `${tls ? 'https+insecure' : 'http'}://127.0.0.1:${port}`;
	const url = `https://${dnsName}`;
	if (!tailnetOnly) {
		const pub = await publish(cli, 'funnel', target, log);
		if (pub.stop) return { url, public: true, stop: pub.stop };
		log(`Tailscale Funnel not available (${pub.reason}${pub.hint ? `: ${pub.hint}` : ''}); using tailnet-only access.`);
	}
	const priv = await publish(cli, 'serve', target, log);
	return priv.stop ? { url, public: false, stop: priv.stop } : priv;
}

const INSTALL = {
	win32: { cmd: 'winget', args: ['install', '--id', 'Tailscale.Tailscale', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'] },
	darwin: { cmd: 'brew', args: ['install', '--cask', 'tailscale'] },
	linux: { cmd: 'sh', args: ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh'] },
};

async function waitFor(check, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await check();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 2000));
	}
	return null;
}

/**
 * "handide remote": one-time setup for access from anywhere. Installs Tailscale on this
 * PC, signs in and allows HTTPS (each through a browser page it opens), then says what
 * to do on the phone. Every step is skipped when already done, so it is safe to rerun.
 */
export async function setupRemote({ log, private: tailnetOnly }) {
	let cli = await findCli();
	if (!cli) {
		const inst = INSTALL[process.platform];
		log('1/3  Installing Tailscale on this PC...');
		if (process.platform === 'win32') log('     Windows may ask for permission: choose Yes.');
		const res = inst ? await run(inst.cmd, inst.args, { timeout: 900000 }) : { code: -1 };
		cli = await waitFor(findCli, 30000);
		if (!cli) {
			log(`     Could not install it automatically${res.out ? ` (${res.out.trim().split('\n').pop()})` : ''}.`);
			log(`     Install it from ${PHONE_APP_URL}, then run "handide remote" again.`);
			openBrowser(PHONE_APP_URL);
			return false;
		}
	}
	log('1/3  Tailscale is installed.');

	let { state, dnsName } = await waitFor(async () => {
		const s = await readStatus(cli);
		return s.state === 'NoState' || s.state === 'Starting' ? null : s;
	}, 30000) || { state: 'NoState' };
	if (state !== 'Running') {
		log('2/3  Sign in to Tailscale (Google, Microsoft, GitHub or Apple account).');
		await runWithBrowserStep(cli, ['up'], { log, what: 'sign in' });
		({ state, dnsName } = (await waitFor(async () => {
			const s = await readStatus(cli);
			return s.state === 'Running' ? s : null;
		}, 60000)) || {});
		if (state !== 'Running') {
			log('     Sign-in did not finish. Run "handide remote" again.');
			return false;
		}
	}
	log(`2/3  Signed in. This PC is ${dnsName}.`);

	// An existing config on 443 (e.g. a running handide) means it was allowed before; leave it alone.
	const current = await run(cli, ['serve', 'status', '--json'], { timeout: 5000 });
	const funnelOn = /"AllowFunnel"\s*:\s*\{\s*"[^"]+:443"\s*:\s*true/.test(current.out);
	if (funnelOn || (tailnetOnly && /"TCP"\s*:\s*\{\s*"443"/.test(current.out))) {
		log('3/3  Already allowed.');
		return true;
	}
	if (/"TCP"\s*:\s*\{\s*"443"/.test(current.out)) {
		log('3/3  handide is running tailnet-only; restart it and allow public access in the browser page it opens.');
		return true;
	}
	// Publishing a placeholder target triggers the one-time approval without needing handide running.
	const verb = tailnetOnly ? 'serve' : 'funnel';
	const what = tailnetOnly ? 'allow HTTPS for your tailnet (once)' : 'allow HTTPS and public access (Funnel) for this PC (once)';
	const res = await runWithBrowserStep(cli, [verb, '--bg', '--yes', '--https=443', 'http://127.0.0.1:9'], { log, what });
	spawnSync(cli, [verb, '--https=443', 'off'], { windowsHide: true, timeout: 5000 });
	if (res.code !== 0) {
		log(`     Not allowed${res.timedOut ? ' in time' : ''} (${res.out.trim().split('\n').pop()}). Run "handide remote" again.`);
		return false;
	}
	log('3/3  Allowed.');
	return true;
}
