/**
 * Turning "here is a photo" into a prompt SAM can answer.
 *
 * SAM needs to be told which object to cut out. The app cannot ask before it
 * has shown the user anything, so the first prompt has to be guessed — and the
 * old colour-model segmenter, useless as a final answer, is a perfectly good
 * guesser. Its weakness is that it over-reaches: it rarely misses the object
 * (1.5% of object pixels on the benchmark) but drags in half the background
 * (48%). A bounding box does not care about the second failure nearly as much
 * as a mask does, which is why a bad mask still yields a usable box.
 *
 * What it cannot be allowed to do is propose a box covering the frame, because
 * SAM answers that with the background. Hence the clamp — see `sam.ts`.
 */

import { segment } from './segment';
import { clampBox, type Box, type Point } from './sam';
import type { Mask } from './raster';

/** Bounding box of everything set in a mask, or the whole frame if empty. */
export function maskBox(mask: Mask, width: number, height: number): Box {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  return { x0, y0, x1, y1 };
}

/**
 * A first guess at the object's extent, safe to hand straight to SAM.
 *
 * Benchmarked end to end: unclamped this scores 88.6% mean IoU with six total
 * failures out of eighty scenes, all of them cluttered desks where the guess
 * spans the frame. Clamped it scores 95.4% with none — within a point of a
 * hand-drawn box.
 */
export function proposeBox(rgba: Uint8ClampedArray, width: number, height: number): Box {
  const { mask } = segment(rgba, width, height, {});
  return clampBox(maskBox(mask, width, height), width, height);
}

/**
 * Sample brush strokes down to a handful of prompt points.
 *
 * A stroke is thousands of pixels and SAM wants a few landmarks, so the strokes
 * are sampled on a grid — spread out rather than clustered, since ten points in
 * one blob say no more than one does.
 */
export function hintsToPoints(
  hints: Uint8Array | null,
  width: number,
  height: number,
  maxPerLabel = 8,
): Point[] {
  if (!hints) return [];
  const step = Math.max(4, Math.round(Math.min(width, height) / 24));
  const keep: Point[] = [];
  const drop: Point[] = [];
  for (let y = Math.floor(step / 2); y < height; y += step) {
    for (let x = Math.floor(step / 2); x < width; x += step) {
      const h = hints[y * width + x];
      if (h === 1 && keep.length < maxPerLabel) keep.push({ x, y, label: 1 });
      else if (h === 2 && drop.length < maxPerLabel) drop.push({ x, y, label: 0 });
    }
  }
  return [...keep, ...drop];
}
