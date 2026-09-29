// Starts a private handide proxy for automated checks: its own data dir, sample
// workspace and layer config under check-output/, so the user's setup is untouched.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const OUT = join(ROOT, 'check-output');
export const SAMPLE = 'function greet(name) {\n  return "hello " + name;\n}\n\nconsole.log(greet("world"));\n';

export const loadPlaywright = () => import(pathToFileURL(join(ROOT, 'node_modules/playwright/index.mjs')).href);

const freePort = () =>
	new Promise((ok, fail) => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => ok(port));
		});
		s.on('error', fail);
	});

export function killTree(child) {
	if (!child || child.exitCode !== null) return;
	if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
	else child.kill('SIGTERM');
}

/**
 * @param {{ mode?: string, editor?: string, host?: string }} opts
 * @returns {Promise<{ child, url, port, token, workspace, editor }>}
 */
export async function startProxy({ mode = 'extension', editor, host } = {}) {
	const workspace = join(OUT, 'workspace');
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, 'hello.js'), SAMPLE);

	const config = JSON.parse(readFileSync(join(ROOT, 'layer.config.json'), 'utf8'));
	config.companion = { ...config.companion, mode };
	const configPath = join(OUT, 'layer.config.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));

	const port = await freePort();
	const token = randomBytes(12).toString('hex');
	const args = [join(ROOT, 'proxy/server.mjs'), '--port', String(port), '--token', token, '--folder', workspace, '--data-dir', join(OUT, 'data'), '--config', configPath];
	if (editor) args.push('--editor', editor);
	if (host) args.push('--host', host);
	else args.push('--local'); // checks use http://localhost (+ adb reverse on Android)
	const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
	let log = '';
	const ready = await new Promise((ok) => {
		const onData = (b) => {
			log += b;
			if (/ready\. Open/.test(log)) ok(true);
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', () => ok(false));
		setTimeout(() => ok(false), 180_000);
	});
	if (!ready) {
		killTree(child);
		throw new Error(`proxy did not start:\n${log}`);
	}
	return {
		child,
		port,
		token,
		url: `http://localhost:${port}/?tkn=${token}`,
		workspace,
		editor: /editor: (.*)/.exec(log)?.[1] ?? 'unknown',
	};
}
