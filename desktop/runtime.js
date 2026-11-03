// The handide that ships inside this extension (app/, put there by desktop/build.mjs), and
// the Node.js it runs on, for a PC where handide was never installed: what the Windows
// installer sets up (installer/build.mjs), done on the first press of the phone button.
//
//   app   copied to <handide home>/runtime/app-<version>: an extension update deletes the
//         old extension folder while handide may still be serving files from it
//   node  the node on the PATH when it is 20 or newer, else the latest Node.js LTS from
//         nodejs.org, checked against the release's SHASUMS256, in <handide home>/runtime
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const MIN_NODE = 20;
const BUNDLED = path.join(__dirname, 'app');
const runtimeDir = () => path.join(process.env.HANDIDE_HOME || path.join(os.homedir(), '.handide'), 'runtime');
const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node';

// process.platform-process.arch → [key in nodejs.org/dist/index.json, file name part, archive]
const DIST = {
	'win32-x64': ['win-x64-zip', 'win-x64', 'zip'],
	'win32-arm64': ['win-arm64-zip', 'win-arm64', 'zip'],
	'darwin-x64': ['osx-x64-tar', 'darwin-x64', 'tar.gz'],
	'darwin-arm64': ['osx-arm64-tar', 'darwin-arm64', 'tar.gz'],
	'linux-x64': ['linux-x64', 'linux-x64', 'tar.gz'],
	'linux-arm64': ['linux-arm64', 'linux-arm64', 'tar.gz'],
};

const appVersion = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const appDir = () => path.join(runtimeDir(), `app-${appVersion()}`);

function nodeMajor(exe) {
	try {
		return Number(/^v(\d+)/.exec(execFileSync(exe, ['-v'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' }))?.[1]) || 0;
	} catch {
		return 0;
	}
}

function systemNode() {
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		const exe = dir && path.join(dir, nodeExe);
		if (exe && fs.existsSync(exe)) return nodeMajor(exe) >= MIN_NODE ? exe : null;
	}
	return null;
}

/** The newest Node.js downloaded here before. */
function ownNode() {
	let dirs = [];
	try {
		dirs = fs.readdirSync(runtimeDir()).filter((d) => /^node-v\d+/.test(d) && !d.endsWith('.tmp'));
	} catch {
		return null;
	}
	dirs.sort((a, b) => Number(/^node-v(\d+)/.exec(b)[1]) - Number(/^node-v(\d+)/.exec(a)[1]));
	for (const d of dirs) {
		const exe = binaryIn(path.join(runtimeDir(), d));
		if (fs.existsSync(exe)) return exe;
	}
	return null;
}

const binaryIn = (dir) => (process.platform === 'win32' ? path.join(dir, nodeExe) : path.join(dir, 'bin', nodeExe));

/** GET into a Buffer, following redirects; onProgress(done, total). */
function get(url, onProgress) {
	return new Promise((ok, fail) => {
		https
			.get(url, { headers: { 'user-agent': 'handide-vscode' }, timeout: 60_000 }, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					return get(new URL(res.headers.location, url).toString(), onProgress).then(ok, fail);
				}
				if (res.statusCode !== 200) {
					res.resume();
					return fail(new Error(`${url}: HTTP ${res.statusCode}`));
				}
				const total = Number(res.headers['content-length']) || 0;
				const chunks = [];
				let done = 0;
				res.on('data', (c) => {
					chunks.push(c);
					done += c.length;
					if (total) onProgress?.(done, total);
				});
				res.on('end', () => ok(Buffer.concat(chunks)));
				res.on('error', fail);
			})
			.on('timeout', function () {
				this.destroy(new Error(`${url}: timed out`));
			})
			.on('error', fail);
	});
}

async function downloadNode(report) {
	const dist = DIST[`${process.platform}-${process.arch}`];
	if (!dist) throw new Error(`there is no Node.js download for ${process.platform}-${process.arch}; install Node.js ${MIN_NODE}+ and press the button again`);
	const [key, plat, ext] = dist;
	report('finding Node.js…');
	const releases = JSON.parse((await get('https://nodejs.org/dist/index.json')).toString());
	const release = releases.find((r) => r.lts && r.files.includes(key));
	if (!release) throw new Error(`no Node.js LTS release for ${plat}`);
	const name = `node-${release.version}-${plat}`;
	const base = `https://nodejs.org/dist/${release.version}`;
	const sums = (await get(`${base}/SHASUMS256.txt`)).toString();
	const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, file]) => file === `${name}.${ext}`)?.[0];
	if (!expected) throw new Error(`no checksum for ${name}.${ext}`);
	let shown = -1;
	const archive = await get(`${base}/${name}.${ext}`, (done, total) => {
		const percent = Math.floor((done / total) * 100);
		if (percent !== shown) report(`downloading Node.js ${release.version} (once)… ${(shown = percent)}%`);
	});
	if (crypto.createHash('sha256').update(archive).digest('hex') !== expected) throw new Error(`the Node.js download did not match its checksum`);

	report('unpacking Node.js…');
	fs.mkdirSync(runtimeDir(), { recursive: true });
	const file = path.join(runtimeDir(), `${name}.${ext}`);
	const tmp = path.join(runtimeDir(), `${name}.${process.pid}.tmp`);
	fs.writeFileSync(file, archive);
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(tmp);
	// tar ships with Windows 10 and later, and reads .zip there.
	const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
	const r = spawnSync(tar, [ext === 'zip' ? '-xf' : '-xzf', file, '-C', tmp], { windowsHide: true, encoding: 'utf8' });
	fs.rmSync(file, { force: true });
	if (r.status !== 0) throw new Error(`could not unpack Node.js: ${(r.stderr || r.error?.message || '').trim()}`);
	const dest = path.join(runtimeDir(), name);
	if (!fs.existsSync(dest)) fs.renameSync(path.join(tmp, name), dest); // another window may have finished first
	fs.rmSync(tmp, { recursive: true, force: true });
	return binaryIn(dest);
}

function ensureApp() {
	const dest = appDir();
	if (!fs.existsSync(path.join(dest, 'proxy', 'server.mjs'))) {
		const tmp = `${dest}.${process.pid}.tmp`;
		fs.rmSync(tmp, { recursive: true, force: true });
		fs.cpSync(BUNDLED, tmp, { recursive: true });
		try {
			fs.renameSync(tmp, dest);
		} catch (err) {
			fs.rmSync(tmp, { recursive: true, force: true });
			if (!fs.existsSync(dest)) throw err; // else another window copied it first
		}
	}
	return path.join(dest, 'proxy', 'server.mjs');
}

const hasBundled = () => fs.existsSync(path.join(BUNDLED, 'proxy', 'server.mjs'));

/** { node, server } of the bundled handide when it is set up already, else null. */
function bundledReady() {
	const server = path.join(appDir(), 'proxy', 'server.mjs');
	if (!hasBundled() || !fs.existsSync(server)) return null;
	const node = systemNode() || ownNode();
	return node ? { node, server } : null;
}

/** { node, server } of the bundled handide, set up first when needed; null in a build without it. */
async function bundledHandide(report) {
	if (!hasBundled()) return null;
	const server = ensureApp();
	const node = systemNode() || ownNode() || (await downloadNode(report));
	return { node, server };
}

/** Where the bundled handide of this extension version runs from; null in a build without it. */
const bundledServer = () => (hasBundled() ? path.join(appDir(), 'proxy', 'server.mjs') : null);

module.exports = { bundledHandide, bundledReady, bundledServer };
