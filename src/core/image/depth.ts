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
