/**
 * Scoring for the segmentation benchmark.
 *
 * IoU alone is a blunt instrument: on a chunky object you can miss the outline
 * by two pixels everywhere and still score 0.97, which is exactly the error
 * that ruins a carved model. So boundary F1 is reported alongside it — it
 * measures only whether the *edge* landed in the right place, and it is where
 * methods actually separate.
 */

import { distanceTransform, type Mask } from '../src/core/image/raster';

export interface Score {
  iou: number;
  boundaryF1: number;
  /** Fraction of truth pixels missed, and of predicted pixels invented. */
  missed: number;
  invented: number;
}

function boundaryOf(mask: Mask, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !mask[i - 1] ||
        !mask[i + 1] ||
        !mask[i - width] ||
        !mask[i + width];
      if (edge) out[i] = 1;
    }
  }
  return out;
}

/** Distance from every pixel to the nearest set pixel of `points`. */
function distanceToSet(points: Uint8Array, width: number, height: number): Float32Array {
  const complement = new Uint8Array(points.length);
  for (let i = 0; i < points.length; i++) complement[i] = points[i] ? 0 : 1;
  return distanceTransform(complement, width, height);
}

export function score(pred: Mask, truth: Mask, width: number, height: number, tolerance = 2): Score {
  let inter = 0;
  let union = 0;
  let truthCount = 0;
  let predCount = 0;
  let missed = 0;
  let invented = 0;
  for (let i = 0; i < truth.length; i++) {
    const p = pred[i] ? 1 : 0;
    const t = truth[i] ? 1 : 0;
    if (p && t) inter++;
    if (p || t) union++;
    if (t) truthCount++;
    if (p) predCount++;
    if (t && !p) missed++;
    if (p && !t) invented++;
  }

  const predEdge = boundaryOf(pred, width, height);
  const truthEdge = boundaryOf(truth, width, height);
  const distToTruthEdge = distanceToSet(truthEdge, width, height);
  const distToPredEdge = distanceToSet(predEdge, width, height);

  let predEdgeTotal = 0;
  let predEdgeHit = 0;
  let truthEdgeTotal = 0;
  let truthEdgeHit = 0;
  for (let i = 0; i < truth.length; i++) {
    if (predEdge[i]) {
      predEdgeTotal++;
      if (distToTruthEdge[i] <= tolerance) predEdgeHit++;
    }
    if (truthEdge[i]) {
      truthEdgeTotal++;
      if (distToPredEdge[i] <= tolerance) truthEdgeHit++;
    }
  }
  const precision = predEdgeTotal === 0 ? 0 : predEdgeHit / predEdgeTotal;
  const recall = truthEdgeTotal === 0 ? 0 : truthEdgeHit / truthEdgeTotal;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    iou: union === 0 ? 1 : inter / union,
    boundaryF1: f1,
    missed: truthCount === 0 ? 0 : missed / truthCount,
    invented: truthCount === 0 ? 0 : invented / truthCount,
  };
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function pct(v: number): string {
  return (v * 100).toFixed(1).padStart(5);
}
