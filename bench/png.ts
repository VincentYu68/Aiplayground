/**
 * Minimal PNG writer, so benchmark scenes can be handed to tools outside this
 * project (the SAM comparison runs in Python) byte-for-byte identically.
 * Node's zlib does the compression; the rest is chunk framing and CRC.
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit RGB (no alpha — scenes are fully composited). */
export function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  // One filter byte per scanline; filter 0 (none) keeps this simple and the
  // images are small enough that the extra bytes do not matter.
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 3);
    raw[dst] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      raw[dst + 1 + x * 3] = rgba[src];
      raw[dst + 1 + x * 3 + 1] = rgba[src + 1];
      raw[dst + 1 + x * 3 + 2] = rgba[src + 2];
    }
  }

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encode a 0/1 mask as a black-and-white PNG. */
export function encodeMaskPng(mask: Uint8Array, width: number, height: number): Uint8Array {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = mask[i] ? 255 : 0;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(rgba, width, height);
}
