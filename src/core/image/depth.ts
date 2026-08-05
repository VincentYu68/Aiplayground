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
 * Thickness field in 0..1, zero outside the mask.
 */
export function estimateDepth(
  rgba: Uint8ClampedArray,
  mask: Mask,
  width: number,
  height: number,
  optionsIn: Partial<DepthOptions> = {},
): Float32Array {
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
  const combined = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    // Shading modulates rather than replaces: it can only push thickness
    // around within the envelope the silhouette allows, which keeps a bright
    // background reflection from blowing a hole through the object.
    const s = 0.55 + 0.45 * smoothShading[i];
    combined[i] = (1 - w) * bulge[i] + w * bulge[i] * s * 1.25;
  }

  const smoothed = boxBlur(combined, width, height, Math.max(1, radius >> 1), 2);
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) {
      smoothed[i] = 0;
      continue;
    }
    if (smoothed[i] > max) max = smoothed[i];
  }
  if (max > 0) {
    for (let i = 0; i < n; i++) smoothed[i] = mask[i] ? smoothed[i] / max : 0;
  }
  return smoothed;
}

/**
 * Radius profile for the rotational-symmetry mode: for each image row, half the
 * silhouette width. Objects like mugs, vases and bottles are far better served
 * by revolving their profile than by extruding their silhouette.
 */
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
