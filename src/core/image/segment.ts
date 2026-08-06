/**
 * Foreground extraction.
 *
 * The whole pipeline hinges on knowing which pixels are the object, and with
 * multi-view carving it hinges harder: a mistake in any one view carves real
 * material out of the finished model, so an error here is not a blemish, it is
 * a hole.
 *
 * The work is done by GrabCut — Gaussian mixture colour models refined against
 * a global min-cut — see `grabcut.ts` for why that beats scoring pixels one at
 * a time. This module handles everything around it: turning the user's box and
 * brush strokes into a trimap, running the cut at a resolution that keeps the
 * app responsive, sharpening the result back to full resolution, and the
 * morphological tidying afterwards.
 *
 * User-painted hints are hard constraints throughout: a stroke is an
 * instruction, not a suggestion, and it survives every stage.
 */

import { rgbToLab } from '../lego/colors';
import { close, fillHoles, keepLargestComponents, open, type Mask } from './raster';
import {
  DEFINITE_BG,
  DEFINITE_FG,
  UNKNOWN,
  grabCut,
  refineBoundary,
  DEFAULT_GRABCUT,
} from './grabcut';
import { negLogProb } from './gmm';

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
  /** Boundary-length weight in the cut. */
  gamma: number;
  /** Denoising radius used when measuring image edges. */
  edgeBlur: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  threshold: 0.5,
  rect: null,
  hints: null,
  minComponentFraction: 0.08,
  fillInteriorHoles: true,
  gamma: DEFAULT_GRABCUT.gamma,
  edgeBlur: DEFAULT_GRABCUT.edgeBlur,
};

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
  /** Foreground confidence per pixel, kept for the editor's preview. */
  score: Float32Array;
}

/** Longest side the cut runs at. Beyond this it costs more than it adds. */
const CUT_MAX_DIM = 220;

/** Average Lab over square blocks. */
function downsampleLab(
  lab: Float32Array,
  width: number,
  height: number,
  factor: number,
): { lab: Float32Array; width: number; height: number } {
  if (factor <= 1) return { lab, width, height };
  const w = Math.max(1, Math.ceil(width / factor));
  const h = Math.max(1, Math.ceil(height / factor));
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let l = 0;
      let a = 0;
      let b = 0;
      let n = 0;
      for (let sy = y * factor; sy < Math.min(height, (y + 1) * factor); sy++) {
        for (let sx = x * factor; sx < Math.min(width, (x + 1) * factor); sx++) {
          const i = sy * width + sx;
          l += lab[i * 3];
          a += lab[i * 3 + 1];
          b += lab[i * 3 + 2];
          n++;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = l / Math.max(1, n);
      out[o + 1] = a / Math.max(1, n);
      out[o + 2] = b / Math.max(1, n);
    }
  }
  return { lab: out, width: w, height: h };
}

/**
 * Turn the box and the brush strokes into the three-way map GrabCut needs.
 *
 * Without either, the border band is taken as background and everything else
 * is left open — the weakest honest assumption available, and enough for the
 * iteration to bootstrap from.
 */
function buildTrimap(
  width: number,
  height: number,
  rect: SegmentOptions['rect'],
  hints: Uint8Array | null,
): Uint8Array {
  const trimap = new Uint8Array(width * height).fill(UNKNOWN);

  if (rect) {
    const x0 = Math.max(0, Math.min(rect.x0, rect.x1));
    const x1 = Math.min(width - 1, Math.max(rect.x0, rect.x1));
    const y0 = Math.max(0, Math.min(rect.y0, rect.y1));
    const y1 = Math.min(height - 1, Math.max(rect.y0, rect.y1));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < x0 || x > x1 || y < y0 || y > y1) trimap[y * width + x] = DEFINITE_BG;
      }
    }
  } else {
    const bandX = Math.max(1, Math.round(width * 0.04));
    const bandY = Math.max(1, Math.round(height * 0.04));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < bandX || y < bandY || x >= width - bandX || y >= height - bandY) {
          trimap[y * width + x] = DEFINITE_BG;
        }
      }
    }
  }

  if (hints) {
    for (let i = 0; i < trimap.length; i++) {
      if (hints[i] === 1) trimap[i] = DEFINITE_FG;
      else if (hints[i] === 2) trimap[i] = DEFINITE_BG;
    }
  }
  return trimap;
}

/** Shrink a trimap, letting any pinned pixel in a block claim the block. */
function downsampleTrimap(
  trimap: Uint8Array,
  width: number,
  height: number,
  factor: number,
  w: number,
  h: number,
): Uint8Array {
  if (factor <= 1) return trimap;
  const out = new Uint8Array(w * h).fill(UNKNOWN);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let fg = 0;
      let bg = 0;
      let total = 0;
      for (let sy = y * factor; sy < Math.min(height, (y + 1) * factor); sy++) {
        for (let sx = x * factor; sx < Math.min(width, (x + 1) * factor); sx++) {
          const v = trimap[sy * width + sx];
          if (v === DEFINITE_FG) fg++;
          else if (v === DEFINITE_BG) bg++;
          total++;
        }
      }
      // A block is only pinned if it is unambiguous; mixed blocks stay open so
      // the cut can put the boundary inside them.
      if (fg > 0 && bg === 0) out[y * w + x] = DEFINITE_FG;
      else if (bg === total && total > 0) out[y * w + x] = DEFINITE_BG;
    }
  }
  return out;
}

/**
 * Where the object probably is, before anything has been measured: the middle
 * of the frame, or the middle of the box if one was drawn. Only a starting
 * point — the cut is free to move the boundary anywhere.
 */
function centralPrior(
  width: number,
  height: number,
  rect: SegmentOptions['rect'],
  factor: number,
  hints: Uint8Array | null,
  fullWidth: number,
): Uint8Array {
  const prior = new Uint8Array(width * height);
  let x0 = 0;
  let x1 = width - 1;
  let y0 = 0;
  let y1 = height - 1;
  if (rect) {
    x0 = Math.min(rect.x0, rect.x1) / factor;
    x1 = Math.max(rect.x0, rect.x1) / factor;
    y0 = Math.min(rect.y0, rect.y1) / factor;
    y1 = Math.max(rect.y0, rect.y1) / factor;
  }
  const insetX = (x1 - x0) * 0.2;
  const insetY = (y1 - y0) * 0.2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside =
        x >= x0 + insetX && x <= x1 - insetX && y >= y0 + insetY && y <= y1 - insetY;
      prior[y * width + x] = inside ? 1 : 0;
    }
  }
  // A painted "keep" stroke is the strongest evidence available of where the
  // object is, so it seeds the prior too.
  if (hints) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sy = y * factor;
        const sx = x * factor;
        if (hints[sy * fullWidth + sx] === 1) prior[y * width + x] = 1;
      }
    }
  }
  return prior;
}

export function segment(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  optionsIn: Partial<SegmentOptions> = {},
): SegmentResult {
  const options = { ...DEFAULT_SEGMENT_OPTIONS, ...optionsIn };
  const n = width * height;
  const lab = toLabBuffer(rgba, width, height);
  const hints = options.hints ?? null;

  const trimap = buildTrimap(width, height, options.rect, hints);

  // Cut at reduced resolution, then sharpen: the colour models do not care
  // about resolution, and the min-cut is by far the expensive part.
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / CUT_MAX_DIM));
  const small = downsampleLab(lab, width, height, factor);
  const smallTrimap = downsampleTrimap(
    trimap,
    width,
    height,
    factor,
    small.width,
    small.height,
  );

  // The sensitivity slider biases the fit term: above the midpoint it charges
  // extra for calling a pixel foreground.
  const bias = (options.threshold - 0.5) * 12;
  const cut = grabCut(
    small.lab,
    small.width,
    small.height,
    smallTrimap,
    { bias, gamma: options.gamma, edgeBlur: options.edgeBlur },
    centralPrior(small.width, small.height, options.rect, factor, hints, width),
  );

  // Back to full resolution, then re-decide the pixels near the boundary
  // against the full-detail image.
  let mask: Mask = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(small.height - 1, Math.floor(y / factor));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(small.width - 1, Math.floor(x / factor));
      mask[y * width + x] = cut.labels[sy * small.width + sx];
    }
  }
  if (factor > 1) {
    refineBoundary(
      lab,
      width,
      height,
      mask,
      trimap,
      cut.foreground,
      cut.background,
      factor + 1,
      options.gamma,
    );
  }

  // Confidence, for the editor to show where the decision was marginal.
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lab[i * 3];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    const fg = negLogProbSafe(cut.foreground, l, a, b);
    const bg = negLogProbSafe(cut.background, l, a, b);
    score[i] = bg / (fg + bg + 1e-6);
  }

  applyHints(mask, hints);
  mask = open(mask, width, height, 1);
  mask = close(mask, width, height, 2);
  if (options.minComponentFraction > 0) {
    mask = keepLargestComponents(mask, width, height, options.minComponentFraction);
  }
  if (options.fillInteriorHoles) mask = fillHoles(mask, width, height);
  applyHints(mask, hints);

  return { mask, score };
}

function applyHints(mask: Mask, hints: Uint8Array | null): void {
  if (!hints) return;
  for (let i = 0; i < mask.length; i++) {
    if (hints[i] === 1) mask[i] = 1;
    else if (hints[i] === 2) mask[i] = 0;
  }
}

function negLogProbSafe(gmm: Parameters<typeof negLogProb>[0], l: number, a: number, b: number) {
  const v = negLogProb(gmm, l, a, b);
  return Number.isFinite(v) ? v : 69;
}
