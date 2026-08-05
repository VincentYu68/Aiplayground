/**
 * Colour reduction onto the LEGO palette.
 *
 * Two stages: pick which LEGO colours this model is allowed to use (a limited
 * set keeps the parts list purchasable and the model coherent), then snap every
 * sampled pixel onto that set.
 *
 * No dithering. Dithering is right for a flat mosaic seen at a distance and
 * wrong for a 3D object seen up close, where it just reads as noise.
 */

import { deltaE2000, nearestColorIndex, PALETTE, rgbToLab, type LegoColor } from '../lego/colors';
import { mulberry32 } from '../image/raster';

export interface PaletteSelection {
  colors: LegoColor[];
  /** Index into `colors` for each input sample. */
  assign: Int16Array;
  meanDeltaE: number;
}

/**
 * Choose at most `maxColors` LEGO colours that best cover the supplied samples.
 *
 * Works by clustering the samples in Lab space and snapping each cluster centre
 * to its nearest real LEGO colour, then greedily filling any remaining budget
 * with whichever unused LEGO colour reduces total error the most. Clustering
 * first stops a photo that is 80% sky from spending its whole colour budget on
 * six shades of blue.
 */
export function selectPalette(
  samples: Float32Array,
  sampleCount: number,
  maxColors: number,
  seed = 1,
): LegoColor[] {
  if (sampleCount === 0) return [PALETTE[0]];
  const budget = maxColors > 0 ? Math.min(maxColors, PALETTE.length) : PALETTE.length;
  if (budget >= PALETTE.length) return [...PALETTE];

  const rand = mulberry32(seed);
  const k = budget;

  // k-means++ seeding over the samples.
  const centers: number[][] = [];
  const first = Math.floor(rand() * sampleCount);
  centers.push([samples[first * 3], samples[first * 3 + 1], samples[first * 3 + 2]]);
  const nearest = new Float32Array(sampleCount).fill(Infinity);
  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let total = 0;
    for (let i = 0; i < sampleCount; i++) {
      const d =
        (samples[i * 3] - c[0]) ** 2 +
        (samples[i * 3 + 1] - c[1]) ** 2 +
        (samples[i * 3 + 2] - c[2]) ** 2;
      if (d < nearest[i]) nearest[i] = d;
      total += nearest[i];
    }
    if (total <= 0) break;
    let target = rand() * total;
    let pick = sampleCount - 1;
    for (let i = 0; i < sampleCount; i++) {
      target -= nearest[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centers.push([samples[pick * 3], samples[pick * 3 + 1], samples[pick * 3 + 2]]);
  }

  const assign = new Int32Array(sampleCount);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < sampleCount; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const cc = centers[c];
        const d =
          (samples[i * 3] - cc[0]) ** 2 +
          (samples[i * 3 + 1] - cc[1]) ** 2 +
          (samples[i * 3 + 2] - cc[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < sampleCount; i++) {
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

  // Snap cluster centres to real colours, keeping the set distinct.
  const chosen: LegoColor[] = [];
  const used = new Set<number>();
  const weights = centers.map((_, c) => {
    let w = 0;
    for (let i = 0; i < sampleCount; i++) if (assign[i] === c) w++;
    return w;
  });
  const order = centers.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  for (const c of order) {
    if (weights[c] === 0) continue;
    let best = -1;
    let bestD = Infinity;
    for (let p = 0; p < PALETTE.length; p++) {
      if (used.has(p)) continue;
      const d = deltaE2000(centers[c], PALETTE[p].lab);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best >= 0) {
      used.add(best);
      chosen.push(PALETTE[best]);
    }
  }
  if (chosen.length === 0) chosen.push(PALETTE[0]);
  return chosen;
}

/** Snap a single sRGB colour onto a palette. */
export function quantizeRgb(
  r: number,
  g: number,
  b: number,
  palette: readonly LegoColor[],
): { index: number; deltaE: number } {
  return nearestColorIndex(rgbToLab(r, g, b), palette);
}
