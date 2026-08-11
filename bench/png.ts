/**
 * Minimal PNG writer, so benchmark scenes can be handed to tools outside this
 * project (the SAM comparison runs in Python) byte-for-byte identically.
 * Node's zlib does the compression; the rest is chunk framing and CRC.
 */

import { deflateSync, inflateSync } from 'node:zlib';

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

/**
 * Read a PNG back in.
 *
 * The renderer that produces the photographic corpus is a browser, so the
 * pictures arrive as PNG and node has to be able to open them to score
 * anything. Only what Chromium's `toDataURL` emits is supported: 8-bit
 * truecolour with or without alpha, no interlacing, no palette. Anything else
 * throws rather than returning quietly wrong pixels.
 */
export function decodePng(buffer: Uint8Array): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i]) {
      throw new Error('not a PNG');
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (offset < buffer.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7],
    );
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = buffer[offset + 16];
      const colourType = buffer[offset + 17];
      const interlace = buffer[offset + 20];
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
      if (interlace !== 0) throw new Error('interlaced PNG');
      if (colourType === 2) channels = 3;
      else if (colourType === 6) channels = 4;
      else if (colourType === 0) channels = 1;
      else throw new Error(`unsupported PNG colour type ${colourType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) {
    compressed.set(c, at);
    at += c.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));

  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth: pick whichever neighbour the gradient predicts best.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      line[i] = value & 0xff;
    }
    src += stride;
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const s = x * channels;
      if (channels === 1) {
        out[d] = line[s];
        out[d + 1] = line[s];
        out[d + 2] = line[s];
        out[d + 3] = 255;
      } else {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = channels === 4 ? line[s + 3] : 255;
      }
    }
    previous.set(line);
  }
  return { rgba: out, width, height };
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
