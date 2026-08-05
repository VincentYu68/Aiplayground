/**
 * Foreground extraction.
 *
 * The whole pipeline hinges on knowing which pixels are the object, so this
 * runs a small colour-model classifier rather than a naive chroma key:
 *
 *   1. cluster the colours in a border band  -> background model
 *   2. cluster the colours in the centre     -> foreground model
 *   3. score every pixel by relative distance to the two models
 *   4. clean up with morphology, component filtering and hole filling
 *
 * User-painted hints (from the brush in the mask editor) are treated as hard
 * constraints *and* fed back into the colour models, so two or three strokes
 * fix the cases where automatic separation struggles.
 */

import { rgbToLab } from '../lego/colors';
import { close, fillHoles, keepLargestComponents, open, type Mask } from './raster';

export type Hint = 0 | 1 | 2; // 0 = none, 1 = foreground, 2 = background

export interface SegmentOptions {
  /** Decision threshold on the foreground score, 0..1. Higher keeps less. */
  threshold: number;
  /** Optional rectangle (in pixels) that bounds the object. */
  rect?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Per-pixel brush hints, same length as the image. */
  hints?: Uint8Array | null;
  /** Drop specks smaller than this fraction of the largest blob. */
  minComponentFraction: number;
  fillInteriorHoles: boolean;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  threshold: 0.5,
  rect: null,
  hints: null,
  minComponentFraction: 0.08,
  fillInteriorHoles: true,
};

interface Cluster {
  lab: [number, number, number];
  weight: number;
}

function kmeans(samples: Float32Array, count: number, k: number, iterations = 8): Cluster[] {
  if (count === 0) return [];
  const kk = Math.min(k, count);
  const centers: number[][] = [];
  // Deterministic spread-out initialisation (k-means++ flavoured, no RNG).
  centers.push([samples[0], samples[1], samples[2]]);
  while (centers.length < kk) {
    let bestIdx = 0;
    let bestDist = -1;
    for (let i = 0; i < count; i++) {
      const l = samples[i * 3];
      const a = samples[i * 3 + 1];
      const b = samples[i * 3 + 2];
      let nearest = Infinity;
      for (const c of centers) {
        const d = (l - c[0]) ** 2 + (a - c[1]) ** 2 + (b - c[2]) ** 2;
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = i;
      }
    }
    centers.push([samples[bestIdx * 3], samples[bestIdx * 3 + 1], samples[bestIdx * 3 + 2]]);
  }

  const assign = new Int32Array(count);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < count; i++) {
      const l = samples[i * 3];
      const a = samples[i * 3 + 1];
      const b = samples[i * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const cc = centers[c];
        const d = (l - cc[0]) ** 2 + (a - cc[1]) ** 2 + (b - cc[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < count; i++) {
      const s = sums[assign[i]];
      s[0] += samples[i * 3];
      s[1] += samples[i * 3 + 1];
      s[2] += samples[i * 3 + 2];
      s[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }

  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < count; i++) counts[assign[i]]++;
  return centers.map((c, i) => ({ lab: c as [number, number, number], weight: counts[i] / count }));
}

function minDistance(clusters: Cluster[], l: number, a: number, b: number): number {
  let best = Infinity;
  for (const c of clusters) {
    const d = Math.sqrt((l - c.lab[0]) ** 2 + (a - c.lab[1]) ** 2 + (b - c.lab[2]) ** 2);
    if (d < best) best = d;
  }
  return best === Infinity ? 1e6 : best;
}

/** Convert an RGBA buffer to a flat Lab buffer (3 floats per pixel). */
export function toLabBuffer(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const [l, a, b] = rgbToLab(rgba[p], rgba[p + 1], rgba[p + 2]);
    out[i * 3] = l;
    out[i * 3 + 1] = a;
    out[i * 3 + 2] = b;
  }
  return out;
}

export interface SegmentResult {
  mask: Mask;
  /** Raw foreground score before thresholding, useful for live slider preview. */
  score: Float32Array;
}

export function segment(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  optionsIn: Partial<SegmentOptions> = {},
): SegmentResult {
  const options = { ...DEFAULT_SEGMENT_OPTIONS, ...optionsIn };
  const lab = toLabBuffer(rgba, width, height);
  const n = width * height;

  const rect = options.rect ?? { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const rx0 = Math.max(0, Math.min(rect.x0, rect.x1));
  const rx1 = Math.min(width - 1, Math.max(rect.x0, rect.x1));
  const ry0 = Math.max(0, Math.min(rect.y0, rect.y1));
  const ry1 = Math.min(height - 1, Math.max(rect.y0, rect.y1));

  const hints = options.hints ?? null;

  // --- gather background samples: the border band, plus any painted hints ---
  const bandX = Math.max(2, Math.round(width * 0.06));
  const bandY = Math.max(2, Math.round(height * 0.06));
  const bgSamples = new Float32Array(n * 3);
  let bgCount = 0;
  const pushSample = (buf: Float32Array, count: number, i: number) => {
    buf[count * 3] = lab[i * 3];
    buf[count * 3 + 1] = lab[i * 3 + 1];
    buf[count * 3 + 2] = lab[i * 3 + 2];
    return count + 1;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const inBorder = x < bandX || y < bandY || x >= width - bandX || y >= height - bandY;
      const outsideRect = x < rx0 || x > rx1 || y < ry0 || y > ry1;
      if (inBorder || outsideRect) bgCount = pushSample(bgSamples, bgCount, i);
    }
  }
  if (hints) {
    for (let i = 0; i < n; i++) if (hints[i] === 2) bgCount = pushSample(bgSamples, bgCount, i);
  }

  // --- foreground samples: the middle of the rect, plus painted hints ---
  const fgSamples = new Float32Array(n * 3);
  let fgCount = 0;
  const cx0 = rx0 + Math.round((rx1 - rx0) * 0.2);
  const cx1 = rx1 - Math.round((rx1 - rx0) * 0.2);
  const cy0 = ry0 + Math.round((ry1 - ry0) * 0.2);
  const cy1 = ry1 - Math.round((ry1 - ry0) * 0.2);
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      fgCount = pushSample(fgSamples, fgCount, y * width + x);
    }
  }
  if (hints) {
    // Painted foreground counts several times over so a couple of strokes can
    // outvote the much larger automatic sample.
    for (let i = 0; i < n; i++) {
      if (hints[i] === 1) {
        for (let r = 0; r < 6 && fgCount < n; r++) fgCount = pushSample(fgSamples, fgCount, i);
      }
    }
  }

  const bgClusters = kmeans(bgSamples, bgCount, 5);
  const fgClusters = kmeans(fgSamples, fgCount, 6);

  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lab[i * 3];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    const dBg = minDistance(bgClusters, l, a, b);
    const dFg = minDistance(fgClusters, l, a, b);
    score[i] = dBg / (dBg + dFg + 1e-6);
  }

  let mask: Mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = score[i] >= options.threshold ? 1 : 0;

  // Hard constraints from the brush and the bounding rectangle.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x < rx0 || x > rx1 || y < ry0 || y > ry1) mask[i] = 0;
    }
  }
  if (hints) {
    for (let i = 0; i < n; i++) {
      if (hints[i] === 1) mask[i] = 1;
      else if (hints[i] === 2) mask[i] = 0;
    }
  }

  mask = open(mask, width, height, 1);
  mask = close(mask, width, height, 2);
  if (options.minComponentFraction > 0) {
    mask = keepLargestComponents(mask, width, height, options.minComponentFraction);
  }
  if (options.fillInteriorHoles) mask = fillHoles(mask, width, height);

  // Re-apply hard constraints; morphology can nibble at painted strokes.
  if (hints) {
    for (let i = 0; i < n; i++) {
      if (hints[i] === 1) mask[i] = 1;
      else if (hints[i] === 2) mask[i] = 0;
    }
  }

  return { mask, score };
}
