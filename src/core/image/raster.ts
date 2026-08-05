/**
 * Small, dependency-free raster helpers shared by segmentation and depth
 * estimation. Everything works on flat typed arrays so it can run in a worker.
 */

export type Mask = Uint8Array; // 0 or 1 per pixel

/** Deterministic PRNG so a given seed always yields the same model. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Separable box blur, repeated to approximate a Gaussian. */
export function boxBlur(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
  passes = 3,
): Float32Array {
  if (radius < 1) return Float32Array.from(src);
  const cur = Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      let count = 0;
      for (let x = -radius; x <= radius; x++) {
        const xx = clamp(x, 0, width - 1);
        sum += cur[row + xx];
        count++;
      }
      for (let x = 0; x < width; x++) {
        tmp[row + x] = sum / count;
        const outX = clamp(x - radius, 0, width - 1);
        const inX = clamp(x + radius + 1, 0, width - 1);
        sum += cur[row + inX] - cur[row + outX];
      }
    }
    // vertical
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let y = -radius; y <= radius; y++) {
        const yy = clamp(y, 0, height - 1);
        sum += tmp[yy * width + x];
        count++;
      }
      for (let y = 0; y < height; y++) {
        cur[y * width + x] = sum / count;
        const outY = clamp(y - radius, 0, height - 1);
        const inY = clamp(y + radius + 1, 0, height - 1);
        sum += tmp[inY * width + x] - tmp[outY * width + x];
      }
    }
  }
  return cur;
}

/** Binary erosion with a square structuring element. */
export function erode(mask: Mask, width: number, height: number, radius = 1): Mask {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let keep = 1;
      for (let dy = -radius; dy <= radius && keep; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height || !mask[yy * width + xx]) {
            keep = 0;
            break;
          }
        }
      }
      out[y * width + x] = keep;
    }
  }
  return out;
}

export function dilate(mask: Mask, width: number, height: number, radius = 1): Mask {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height && mask[yy * width + xx]) {
            hit = 1;
            break;
          }
        }
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

export function open(mask: Mask, w: number, h: number, r = 1): Mask {
  return dilate(erode(mask, w, h, r), w, h, r);
}

export function close(mask: Mask, w: number, h: number, r = 1): Mask {
  return erode(dilate(mask, w, h, r), w, h, r);
}

/**
 * Label 4-connected components. Returns the label image (0 = background) and
 * the pixel count of each label, indexed from 1.
 */
export function connectedComponents(
  mask: Mask,
  width: number,
  height: number,
): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(mask.length).fill(0);
  const sizes: number[] = [0];
  const stack = new Int32Array(mask.length);
  let next = 1;

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = next;
    let count = 0;
    while (sp > 0) {
      const p = stack[--sp];
      count++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) {
        labels[p - 1] = next;
        stack[sp++] = p - 1;
      }
      if (x < width - 1 && mask[p + 1] && !labels[p + 1]) {
        labels[p + 1] = next;
        stack[sp++] = p + 1;
      }
      if (y > 0 && mask[p - width] && !labels[p - width]) {
        labels[p - width] = next;
        stack[sp++] = p - width;
      }
      if (y < height - 1 && mask[p + width] && !labels[p + width]) {
        labels[p + width] = next;
        stack[sp++] = p + width;
      }
    }
    sizes.push(count);
    next++;
  }
  return { labels, sizes };
}

/** Keep components at least `minFraction` of the largest one. */
export function keepLargestComponents(mask: Mask, width: number, height: number, minFraction = 0.12): Mask {
  const { labels, sizes } = connectedComponents(mask, width, height);
  if (sizes.length <= 1) return mask;
  let max = 0;
  for (let i = 1; i < sizes.length; i++) max = Math.max(max, sizes[i]);
  const threshold = max * minFraction;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i];
    out[i] = l > 0 && sizes[l] >= threshold ? 1 : 0;
  }
  return out;
}

/** Fill enclosed background pockets — a mug handle stays open, a logo hole closes. */
export function fillHoles(mask: Mask, width: number, height: number): Mask {
  const outside = new Uint8Array(mask.length);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] || !outside[i] ? 1 : 0;
  return out;
}

/**
 * Two-pass chamfer distance transform: for every foreground pixel, the
 * approximate distance to the nearest background pixel.
 */
export function distanceTransform(mask: Mask, width: number, height: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) d[i] = mask[i] ? INF : 0;

  const D1 = 1;
  const D2 = Math.SQRT2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + D1);
      if (y > 0) m = Math.min(m, d[i - width] + D1);
      if (x > 0 && y > 0) m = Math.min(m, d[i - width - 1] + D2);
      if (x < width - 1 && y > 0) m = Math.min(m, d[i - width + 1] + D2);
      d[i] = m;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x < width - 1) m = Math.min(m, d[i + 1] + D1);
      if (y < height - 1) m = Math.min(m, d[i + width] + D1);
      if (x < width - 1 && y < height - 1) m = Math.min(m, d[i + width + 1] + D2);
      if (x > 0 && y < height - 1) m = Math.min(m, d[i + width - 1] + D2);
      d[i] = m;
    }
  }
  return d;
}

export function bounds(mask: Mask, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
