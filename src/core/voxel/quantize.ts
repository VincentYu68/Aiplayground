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

import {
  deltaE2000,
  nearestColorIndex,
  PALETTE,
  rgbToLab,
  type ColorSupply,
  type LegoColor,
} from '../lego/colors';

/**
 * What a scarce colour has to be worth, in CIEDE2000, before it is chosen.
 *
 * A colour that exists in a handful of small elements is not free: the tiler can
 * only lay it in 1x1s and 1x2s, so choosing it costs part count as well as
 * shopping trouble. The palette used to be picked on colour distance alone, and
 * on the corpus mug that put 19% of a *white* mug into Light Aqua -- a pale
 * green, marginally closer to one shaded sample than White was, and enough for
 * the manual to instruct someone to "add these 11 parts, Light Aqua".
 *
 * A penalty rather than a ban, because banning scarce colours would take Light
 * Nougat with it, and Light Nougat is 80% of the teddy with no core colour
 * anywhere near it. Something scarce has to be clearly better, not marginally
 * better.
 */
export const SUPPLY_PENALTY: Record<ColorSupply, number> = {
  core: 0,
  common: 0.6,
  limited: 3,
  // Never selectable: PALETTE already excludes these, and the entry is here so
  // the record stays exhaustive if that ever changes.
  retired: 1e6,
};
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

  // Distance from every sample to every LEGO colour, computed once. Everything
  // below is table lookups on top of this, which is what makes it affordable to
  // choose the palette by measured error rather than by proximity of centres.
  const cost = new Float32Array(sampleCount * PALETTE.length);
  for (let i = 0; i < sampleCount; i++) {
    const lab = [samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]];
    for (let p = 0; p < PALETTE.length; p++) {
      cost[i * PALETTE.length + p] = deltaE2000(lab, PALETTE[p].lab) + SUPPLY_PENALTY[PALETTE[p].supply];
    }
  }

  // Snap each cluster centre to its nearest real colour, and let two centres
  // that want the same colour *have* it.
  //
  // Forcing the set to be distinct here was actively harmful: a white mug
  // clusters into several near-white shades, the first took White and the rest
  // were pushed onto whatever was next — so the model came out in two greys.
  // A red car put bricks on the road in magenta the same way. Collapsing costs
  // nothing, because the budget that frees up is spent below on whichever
  // colour actually reduces the error.
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
      const d = deltaE2000(centers[c], PALETTE[p].lab);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best >= 0) used.add(best);
  }
  if (used.size === 0) used.add(0);

  // Spend what is left of the budget on the colour that most reduces the error
  // actually being made, and stop as soon as the next one is not worth the
  // extra line in the parts list. An extra colour is not free: a part cannot
  // cross a colour boundary, so every additional shade fragments the layers and
  // costs pieces.
  const best = new Float32Array(sampleCount).fill(Infinity);
  for (let i = 0; i < sampleCount; i++) {
    for (const p of used) best[i] = Math.min(best[i], cost[i * PALETTE.length + p]);
  }
  while (used.size < budget) {
    let bestP = -1;
    let bestGain = 0;
    for (let p = 0; p < PALETTE.length; p++) {
      if (used.has(p)) continue;
      let gain = 0;
      for (let i = 0; i < sampleCount; i++) {
        const d = cost[i * PALETTE.length + p];
        if (d < best[i]) gain += best[i] - d;
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestP = p;
      }
    }
    // Mean CIEDE2000 improvement across the whole model. Below roughly a third
    // of a unit the change is not visible, and the fragmentation is.
    if (bestP < 0 || bestGain / sampleCount < MIN_COLOUR_GAIN) break;
    used.add(bestP);
    for (let i = 0; i < sampleCount; i++) {
      best[i] = Math.min(best[i], cost[i * PALETTE.length + bestP]);
    }
  }

  const chosen = [...used].sort((a, b) => a - b).map((p) => PALETTE[p]);
  if (chosen.length === 0) chosen.push(PALETTE[0]);
  return chosen;
}

/**
 * Smallest mean CIEDE2000 improvement that justifies adding another colour to
 * the palette. Roughly the threshold where a difference stops being visible
 * side by side.
 */
const MIN_COLOUR_GAIN = 0.35;

/** Snap a single sRGB colour onto a palette. */
export function quantizeRgb(
  r: number,
  g: number,
  b: number,
  palette: readonly LegoColor[],
): { index: number; deltaE: number } {
  return nearestColorIndex(rgbToLab(r, g, b), palette);
}
