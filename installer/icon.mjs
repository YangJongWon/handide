// Draws handide's icon (a phone on a blue rounded square) and writes it as a Windows .ico,
// so the installer, shortcuts and Explorer menu don't show PowerShell's or Node's icon.
// Shapes are signed distance fields, which keeps every size crisp and anti-aliased.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0, 101, 169]; // VS Code blue
const FG = [255, 255, 255];

/** Distance to a rounded box centred at (cx, cy); negative inside. */
function roundBox(x, y, cx, cy, hw, hh, r) {
	const qx = Math.abs(x - cx) - hw + r;
	const qy = Math.abs(y - cy) - hh + r;
	return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const cover = (d, px) => Math.min(1, Math.max(0, 0.5 - d / px));

/** RGBA pixels, rows top to bottom. Coordinates are in a 0..1 square. */
function draw(size) {
	const px = 1 / size;
	const out = Buffer.alloc(size * size * 4);
	for (let j = 0; j < size; j++) {
		for (let i = 0; i < size; i++) {
			const x = (i + 0.5) * px;
			const y = (j + 0.5) * px;
			const bg = cover(roundBox(x, y, 0.5, 0.5, 0.48, 0.48, 0.2), px);
			// Phone: an outlined body, a filled screen line pattern would vanish at 16px.
			const body = roundBox(x, y, 0.5, 0.5, 0.21, 0.33, 0.07);
			const ring = cover(Math.abs(body) - 0.035, px);
			const button = cover(Math.hypot(x - 0.5, y - 0.73) - 0.035, px);
			const code = cover(roundBox(x, y, 0.5, 0.42, 0.09, 0.025, 0.02), px) + cover(roundBox(x, y, 0.47, 0.52, 0.06, 0.025, 0.02), px);
			const fg = Math.min(1, ring + button + (size >= 32 ? code : 0));
			const o = (j * size + i) * 4;
			for (let c = 0; c < 3; c++) out[o + c] = Math.round(BG[c] * (1 - fg) + FG[c] * fg);
			out[o + 3] = Math.round(255 * bg);
		}
	}
	return out;
}

const CRC = new Int32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc32 = (buf) => {
	let c = -1;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};

function png(size, rgba) {
	const chunk = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length);
		head.write(type, 4, 'ascii');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let j = 0; j < size; j++) rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** Classic 32-bit DIB entry (BGRA, bottom-up, plus an AND mask), readable by every tool. */
function dib(size, rgba) {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(size, 4);
	header.writeInt32LE(size * 2, 8); // colour + mask
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	const pixels = Buffer.alloc(size * size * 4);
	for (let j = 0; j < size; j++) {
		for (let i = 0; i < size; i++) {
			const s = (j * size + i) * 4;
			const d = ((size - 1 - j) * size + i) * 4;
			pixels.set([rgba[s + 2], rgba[s + 1], rgba[s], rgba[s + 3]], d);
		}
	}
	const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all zero: alpha decides
	return Buffer.concat([header, pixels, mask]);
}

export function writeIcon(file) {
	const images = [16, 24, 32, 48, 256].map((size) => {
		const rgba = draw(size);
		return { size, data: size === 256 ? png(size, rgba) : dib(size, rgba) };
	});
	const head = Buffer.alloc(6 + 16 * images.length);
	head.writeUInt16LE(1, 2); // type: icon
	head.writeUInt16LE(images.length, 4);
	let offset = head.length;
	images.forEach(({ size, data }, k) => {
		const e = 6 + 16 * k;
		head[e] = size === 256 ? 0 : size;
		head[e + 1] = size === 256 ? 0 : size;
		head.writeUInt16LE(1, e + 4);
		head.writeUInt16LE(32, e + 6);
		head.writeUInt32LE(data.length, e + 8);
		head.writeUInt32LE(offset, e + 12);
		offset += data.length;
	});
	writeFileSync(file, Buffer.concat([head, ...images.map((i) => i.data)]));
}

/** A PNG preview, for looking at the design. */
export function writePreview(file, size = 256) {
	writeFileSync(file, png(size, draw(size)));
}
