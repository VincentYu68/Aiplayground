/**
 * Lifting a single photo into a 3D thickness field.
 *
 * One photograph does not contain enough information to recover true geometry,
 * so this combines two cues that are individually weak but complementary:
 *
 *   - a *bulge profile* derived from the distance transform of the silhouette.
 *     Points deep inside the outline are thick, points near the edge taper to
 *     nothing. That is exactly what a smooth convex object looks like and it
 *     is what makes the finished sculpture read as solid rather than as a
 *     cardboard cut-out.
 *   - a *shading cue* from image luminance, which recovers surface relief
 *     (folds, panel lines, a nose on a face) that the silhouette cannot know
 *     about.
 *
 * The result is a normalised thickness in 0..1 per pixel, later scaled to studs.
 */

import { boxBlur, distanceTransform, type Mask } from './raster';

export interface DepthOptions {
  /** 0 = pure geometric bulge, 1 = pure shading. */
  shadingInfluence: number;
  /** Smoothing radius as a fraction of the image's short side. */
  smoothing: number;
}

export const DEFAULT_DEPTH_OPTIONS: DepthOptions = {
  shadingInfluence: 0.25,
  smoothing: 0.02,
};

function luminance(rgba: Uint8ClampedArray, i: number): number {
  return (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
}

/**
 * How far the surface sits from the object's centre plane, front and back,
 * each in 0..1 of the model's depth. `front + back` peaks at exactly 1.
 *
 * They are separate because the two sides are known to different degrees. The
 * silhouette constrains both equally, but shading only ever describes the side
 * facing the camera — mirroring it onto the back puts a second nose on the back
 * of a head.
 */
export interface DepthField {
  front: Float32Array;
  back: Float32Array;
}

export function estimateDepth(
  rgba: Uint8ClampedArray,
  mask: Mask,
  width: number,
  height: number,
  optionsIn: Partial<DepthOptions> = {},
): DepthField {
  const options = { ...DEFAULT_DEPTH_OPTIONS, ...optionsIn };
  const n = width * height;

  // --- geometric bulge -----------------------------------------------------
  const dist = distanceTransform(mask, width, height);
  let maxDist = 0;
  for (let i = 0; i < n; i++) if (dist[i] > maxDist) maxDist = dist[i];
  const bulge = new Float32Array(n);
  if (maxDist > 0) {
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const t = Math.min(1, dist[i] / maxDist);
      // Circular cross-section: height of a unit circle at inset t.
      bulge[i] = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    }
  }

  // --- shading cue ---------------------------------------------------------
  const shading = new Float32Array(n);
  if (options.shadingInfluence > 0) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const l = luminance(rgba, i);
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
    const range = hi - lo;
    if (range > 1e-4) {
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        shading[i] = (luminance(rgba, i) - lo) / range;
      }
    }
  }

  const radius = Math.max(1, Math.round(Math.min(width, height) * options.smoothing));
  const smoothShading = boxBlur(shading, width, height, radius, 2);

  const w = Math.max(0, Math.min(1, options.shadingInfluence));
  const smoothBulge = boxBlur(bulge, width, height, Math.max(1, radius >> 1), 2);

  const front = new Float32Array(n);
  const back = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const half = 0.5 * smoothBulge[i];

    // The back is the bare geometric bulge: the photograph says nothing about
    // it beyond the outline, so inventing detail there is worse than leaving
    // it smooth.
    back[i] = half;

    // The front carries the shading relief on top of that bulge. It is scaled
    // by the bulge so it fades out at the silhouette and the outline stays
    // crisp — and it only ever adds, so a dark patch cannot punch a dent
    // through the object.
    front[i] = half * (1 + w * 0.5 * smoothShading[i]);

    const total = front[i] + back[i];
    if (total > max) max = total;
  }
  if (max > 0) {
    for (let i = 0; i < n; i++) {
      front[i] /= max;
      back[i] /= max;
    }
  }
  return { front, back };
}

/**
 * Radius profile for the rotational-symmetry mode: for each image row, half the
 * silhouette width. Objects like mugs, vases and bottles are far better served
 * by revolving their profile than by extruding their silhouette.
 */
/** Axis of revolution and the body's half-width at each row, in pixels. */
export interface LatheProfile {
  /** Horizontal position of the axis, constant over the whole object. */
  axis: number;
  /** Half-width of the body at each row; 0 where the body is absent. */
  radius: Float32Array;
}

/**
 * Fit an axis of revolution and a radius profile to a silhouette.
 *
 * The naive version of this — the row's leftmost and rightmost object pixel —
 * is wrong for the single most common lathe-turned object anyone photographs.
 * A mug's handle is part of the silhouette, so the row extent spans the body,
 * the gap, *and* the handle: the radius comes out about 40% too large and the
 * axis is dragged sideways. The model then samples its colours from wherever
 * that displaced geometry happens to land, which is what split the test mug
 * into two mismatched vertical bands.
 *
 * So the body is taken to be the widest *contiguous* run in each row — a
 * detached handle is a different run and drops out — and the axis is the
 * width-weighted median of those runs' centres, which survives the few rows
 * where the handle does touch the body. The radius is then the *smaller* of the
 * two distances from the axis to the ends of the run through it, since it is
 * the handle's side that is inflated when they merge.
 */
export function latheProfile(mask: Mask, width: number, height: number): LatheProfile {
  const centres: Array<{ c: number; w: number }> = [];
  const runs = new Int32Array(height * 2).fill(-1);

  for (let y = 0; y < height; y++) {
    let bestStart = -1;
    let bestEnd = -1;
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && mask[y * width + x] !== 0;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start > bestEnd - bestStart) {
          bestStart = start;
          bestEnd = x;
        }
        start = -1;
      }
    }
    runs[y * 2] = bestStart;
    runs[y * 2 + 1] = bestEnd;
    if (bestStart >= 0) centres.push({ c: (bestStart + bestEnd) / 2, w: bestEnd - bestStart });
  }

  let axis = width / 2;
  if (centres.length > 0) {
    centres.sort((a, b) => a.c - b.c);
    const total = centres.reduce((s, r) => s + r.w, 0);
    let seen = 0;
    for (const r of centres) {
      seen += r.w;
      if (seen * 2 >= total) {
        axis = r.c;
        break;
      }
    }
  }

  const radius = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const s = runs[y * 2];
    const e = runs[y * 2 + 1];
    if (s < 0) continue;
    // Only a run that actually straddles the axis describes the body.
    if (axis < s || axis > e) continue;
    radius[y] = Math.max(0, Math.min(axis - s, e - axis));
  }
  return { axis, radius };
}

export function radiusProfile(mask: Mask, width: number, height: number): Float32Array {
  const radii = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (minX < 0) minX = x;
        maxX = x;
      }
    }
    radii[y] = maxX < 0 ? 0 : (maxX - minX + 1) / 2;
  }
  return radii;
}

/** Horizontal centre of the silhouette per row, for revolve mode. */
export function centerProfile(mask: Mask, width: number, height: number): Float32Array {
  const centers = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (minX < 0) minX = x;
        maxX = x;
      }
    }
    centers[y] = maxX < 0 ? width / 2 : (minX + maxX) / 2;
  }
  return centers;
}
