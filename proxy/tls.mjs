// Self-signed HTTPS for LAN access. Phones only connect to VS Code from a secure
// context (https or localhost), so plain http://<LAN-IP> is not an option. The
// certificate is created once, kept in the handide data dir, and regenerated when
// the machine's addresses change or it nears expiry.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import selfsigned from 'selfsigned';

// Adapters that are never how a phone reaches this PC.
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|br-|veth|Loopback|Npcap/i;

/** LAN addresses a phone could use, best first: Wi-Fi/Ethernet private ranges, then Tailscale. */
export function lanAddresses() {
	const found = [];
	for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
		if (VIRTUAL.test(name)) continue;
		for (const a of addrs || []) {
			if (a.family !== 'IPv4' || a.internal) continue;
			const ip = a.address;
			const rank = /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^100\./.test(ip) ? 3 : 4;
			found.push({ ip, name, rank, tailscale: rank === 3 });
		}
	}
	return found.sort((a, b) => a.rank - b.rank);
}

/** Returns { cert, key, fingerprint } for localhost + hostname + the given IPs. */
export async function ensureCert(dataDir, ips) {
	const dir = join(dataDir, 'tls');
	const names = ['localhost', os.hostname()];
	const wanted = JSON.stringify({ names, ips: [...ips, '127.0.0.1'].sort() });
	try {
		const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
		const fresh = meta.subject === wanted && Date.now() < meta.expires - 30 * 86400_000;
		if (fresh) {
			return { cert: await readFile(join(dir, 'cert.pem'), 'utf8'), key: await readFile(join(dir, 'key.pem'), 'utf8'), fingerprint: meta.fingerprint };
		}
	} catch {
		// no certificate yet
	}
	const days = 825; // longest validity browsers accept for TLS server certificates
	const pems = await selfsigned.generate([{ name: 'commonName', value: `handide ${os.hostname()}` }], {
		days,
		keySize: 2048,
		algorithm: 'sha256',
		extensions: [
			{ name: 'basicConstraints', cA: false },
			{ name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
			{ name: 'extKeyUsage', serverAuth: true },
			{
				name: 'subjectAltName',
				altNames: [...names.map((value) => ({ type: 2, value })), ...[...ips, '127.0.0.1'].map((ip) => ({ type: 7, ip }))],
			},
		],
	});
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'cert.pem'), pems.cert);
	await writeFile(join(dir, 'key.pem'), pems.private, { mode: 0o600 });
	await writeFile(join(dir, 'meta.json'), JSON.stringify({ subject: wanted, expires: Date.now() + days * 86400_000, fingerprint: pems.fingerprint }));
	return { cert: pems.cert, key: pems.private, fingerprint: pems.fingerprint };
}
