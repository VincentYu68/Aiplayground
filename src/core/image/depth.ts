/**
 * Lifting a single photo into a 3D thickness field.
 *
 * There are two ways in here and they are not equally good.
 *
 * `depthFieldFromRelief` is the real one: it takes a *measured* monocular depth
 * map (see `monodepth.ts`) and uses it as the surface facing the camera. It
 * knows that a car's wheels stand in front of its doors and its greenhouse sits
 * behind them, because a network that has seen 62M images knows that and a
 * silhouette never can.
 *
 * `estimateDepth` is the fallback for when those 35MB of weights are
 * unreachable. It invents depth from the distance transform of the silhouette —
 * thick in the middle, tapering at the edge — which is a *pillow*, not a shape.
 * Every object comes out as an inflated version of its own outline. It is kept
 * because a worse shape beats a failed upload, and for no other reason. Do not
 * treat the two as interchangeable.
 *
 * Both produce the same thing: a front and back half-thickness per pixel, in
 * 0..1 of the model's depth, later scaled to studs by `voxelize`.
 */

import { boxBlur, distanceTransform, erode, type Mask } from './raster';

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
 * They are separate because the two sides are known to different degrees. A
 * photograph describes exactly one surface — the one facing the camera — and
 * the back has to be invented no matter how good the depth map is. Mirroring
 * measured relief onto the back puts a second nose on the back of a head, so
 * the back is a smooth closure and the front carries all the detail.
 */
export interface DepthField {
  front: Float32Array;
  back: Float32Array;
  /**
   * Multiplier on the depth prior, measured from how much relief the depth map
   * actually contains, or null when there was nothing to measure. 1 leaves the
   * prior untouched; below 1 says the object is flatter than its proportions
   * suggest. Deliberately a small correction — see `reliefScaleFrom`.
   */
  reliefScale: number | null;
}

export interface ReliefOptions {
  /**
   * Cross-section between a slab and a circle: 0 tapers only in a narrow band
   * at the outline, 1 is a full circular profile. Set from the shape prior,
   * because it is the one thing about closure a class label really does say.
   */
  roundness: number;
  /**
   * Half the finished model's depth, **in image pixels**. This is the scale over
   * which the surface rolls over the silhouette edge, and getting it from
   * anywhere else is the bug that made every plan view a circle — see
   * `closureProfile`.
   */
  halfDepthPx: number;
  /**
   * How far the measured relief may move the front surface, in units of the
   * model's half-depth. The whole point of the exercise, so it is not small.
   */
  reliefGain: number;
  /** Smoothing radius as a fraction of the image's short side. */
  smoothing: number;
}

export const DEFAULT_RELIEF_OPTIONS: Omit<ReliefOptions, 'halfDepthPx'> = {
  roundness: 0.6,
  reliefGain: 0.45,
  smoothing: 0.012,
};

/** Value below which `p` of the samples fall; `values` is sorted in place. */
function percentile(values: Float32Array, count: number, p: number): number {
  if (count === 0) return 0;
  const slice = values.subarray(0, count);
  slice.sort();
  return slice[Math.min(count - 1, Math.max(0, Math.round(p * (count - 1))))];
}

/**
 * Half-thickness profile that closes the volume at the silhouette.
 *
 * At the outline of a smooth solid the surface is tangent to the line of sight,
 * so the thickness there really is zero — that part is geometry, not a guess.
 * What has to be chosen is the *distance over which* it thickens, and choosing
 * it wrongly is subtle and ruinous.
 *
 * This used to taper over a fraction of `maxDist`, the largest distance-
 * transform value. That is a property of the silhouette's width and height, so
 * the taper spanned the whole body of anything elongated and the plan view
 * closed into a circle: a car seen from above came out as a disc. It was the
 * distance-transform pillow again, one level down — removed from the front
 * surface but still governing the closure, and the closure is what sets the
 * plan-view shape.
 *
 * The right scale is the object's own **half-depth**. A cylinder lying on its
 * side rolls over its silhouette edge across a distance equal to its radius, and
 * nothing about its length changes that. So the band is the half-depth, scaled
 * down by `roundness` towards a slab's small fillet. For a sphere the half-depth
 * *is* `maxDist` and nothing changes, which is the sanity check.
 */
function closureProfile(
  dist: Float32Array,
  maxDist: number,
  mask: Mask,
  roundness: number,
  halfDepthPx: number,
): Float32Array {
  const profile = new Float32Array(dist.length);
  if (maxDist <= 0) return profile;
  // Tapering over more than the silhouette's own inradius would mean the object
  // never reaches full thickness anywhere; at that point it is thinner than it
  // is deep and a full circular roll-off is the right answer anyway.
  const band = Math.max(
    1,
    Math.min(maxDist, halfDepthPx * (0.15 + 0.85 * Math.max(0, Math.min(1, roundness)))),
  );
  for (let i = 0; i < dist.length; i++) {
    if (!mask[i]) continue;
    const t = Math.min(1, dist[i] / band);
    profile[i] = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  }
  return profile;
}

/**
 * How much the depth prior should be trimmed, given how flat the depth map says
 * the object is.
 *
 * Relative depth cannot be turned into a real depth without knowing the camera,
 * so this is not a measurement of the object's thickness and does not pretend to
 * be. What it can see is a ratio: the object's own disparity spread against how
 * far the object stands out from its background. A ball uses up much of that
 * gap, a poster on a wall almost none — and "this is flat" is exactly the case
 * a proportions-and-class-label prior gets most wrong.
 *
 * It is clamped hard and only ever trims, because the two ways it goes wrong
 * both inflate: a studio backdrop the network reads as *near* rather than far
 * collapses the denominator, and an object that fills the frame leaves no
 * background to compare against at all. Returns null when there is no usable
 * background, which is the honest answer rather than a confident 1.
 */
function reliefScaleFrom(
  relief: Float32Array,
  mask: Mask,
  objectSpread: number,
): number | null {
  const n = mask.length;
  let outside = 0;
  const scratch = new Float32Array(n);
  for (let i = 0; i < n; i++) if (!mask[i]) scratch[outside++] = relief[i];
  // Less than a fifth of the frame outside the object is not a background, it
  // is a crop, and its statistics say nothing about how far away anything is.
  if (outside < n * 0.2) return null;

  const backgroundFar = percentile(scratch, outside, 0.25);
  let objectNear = -Infinity;
  let objectCount = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    objectCount++;
    if (relief[i] > objectNear) objectNear = relief[i];
  }
  if (objectCount === 0) return null;

  const contrast = objectNear - backgroundFar;
  // The object has to actually stand in front of its background for the ratio
  // to mean anything. On a white sweep it often does not.
  if (!(contrast > 0) || objectSpread <= 0 || objectSpread > contrast) return null;

  // Typical framing puts a compact object around a third of the way through
  // its own standout, so that is the point where the prior is left alone.
  const fraction = objectSpread / contrast;
  return Math.max(0.7, Math.min(1, 0.55 + 1.35 * fraction));
}

/**
 * What the depth map says, before anything is decided about the model.
 *
 * This is separated from building the field because of an ordering problem that
 * is easy to get wrong: the closure needs to know how deep the model will be,
 * the depth extent needs to know how much relief was measured, and doing both at
 * once is what led to the extent being derived twice with two different
 * meanings. So the statistics come first, the extent is decided once from them,
 * and the field is built knowing it.
 */
export interface ReliefMeasurement {
  /** Smoothed elevation toward the camera, 0..1 across the object. */
  elevation: Float32Array;
  /** Multiplier on the depth prior; see `reliefScaleFrom`. */
  reliefScale: number | null;
}

/**
 * Normalise a measured relative depth map over the object.
 *
 * `relief` is inverse relative depth on the photo's own pixel grid — larger is
 * nearer, scale and shift arbitrary. Only its shape within the mask is used;
 * nothing here treats it as a distance.
 */
export function measureRelief(
  relief: Float32Array,
  mask: Mask,
  width: number,
  height: number,
  smoothing = DEFAULT_RELIEF_OPTIONS.smoothing,
): ReliefMeasurement {
  const n = width * height;
  const elevation = new Float32Array(n);

  // Statistics come from an eroded mask. The prediction is produced on a 37x37
  // patch grid and upsampled, so the last couple of pixels inside the outline
  // carry the background's depth, not the object's — and since those are the
  // extremes of the range, they are exactly what a percentile would latch onto.
  const inner = erode(mask, width, height, Math.max(1, Math.round(Math.min(width, height) * 0.01)));
  const scratch = new Float32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (inner[i]) scratch[count++] = relief[i];
  if (count < 16) {
    count = 0;
    for (let i = 0; i < n; i++) if (mask[i]) scratch[count++] = relief[i];
  }
  if (count === 0) return { elevation, reliefScale: null };

  const lo = percentile(scratch, count, 0.02);
  const hi = percentile(scratch, count, 0.98);
  const span = hi - lo;
  const reliefScale = reliefScaleFrom(relief, mask, span);

  if (span > 1e-9) {
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      elevation[i] = Math.max(0, Math.min(1, (relief[i] - lo) / span));
    }
  } else {
    for (let i = 0; i < n; i++) if (mask[i]) elevation[i] = 0.5;
  }
  const radius = Math.max(1, Math.round(Math.min(width, height) * smoothing));
  return { elevation: boxBlur(elevation, width, height, radius, 2), reliefScale };
}

/**
 * Turn a measured depth map into a front/back thickness field.
 *
 * The construction is deliberately lopsided:
 *
 *   back  = the closure profile alone. The photograph says nothing about the
 *           far side beyond the outline, so it stays smooth.
 *   front = the same profile, pushed forward or back by the measured relief.
 *
 * That asymmetry is what makes a car read as a car: the wheels, which the depth
 * map puts nearest, push out in front of the doors, and the greenhouse, which it
 * puts furthest, is set back and comes out thinner. Both effects survive the
 * trip through the voxeliser because they change the column's *placement* along
 * z as well as its thickness.
 */
export function depthFieldFromRelief(
  measurement: ReliefMeasurement,
  mask: Mask,
  width: number,
  height: number,
  optionsIn: Partial<ReliefOptions> & Pick<ReliefOptions, 'halfDepthPx'>,
): DepthField {
  const options = { ...DEFAULT_RELIEF_OPTIONS, ...optionsIn };
  const n = width * height;
  const front = new Float32Array(n);
  const back = new Float32Array(n);
  const elevation = measurement.elevation;

  const dist = distanceTransform(mask, width, height);
  let maxDist = 0;
  for (let i = 0; i < n; i++) if (dist[i] > maxDist) maxDist = dist[i];
  const profile = closureProfile(dist, maxDist, mask, options.roundness, options.halfDepthPx);

  // The relief redistributes depth rather than adding it, so it is measured
  // against the object's own middle — weighted by the profile so the tapering
  // rim, where the prediction is least trustworthy, does not set the datum.
  let weighted = 0;
  let weight = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    weighted += elevation[i] * profile[i];
    weight += profile[i];
  }
  const datum = weight > 0 ? weighted / weight : 0.5;

  // Relief has to fade at the very outline or the silhouette stops closing and
  // the model grows a hard rim. That band is a third of the closure band and no
  // more: tying it to the silhouette's size instead would fade the relief out
  // across the whole of an elongated object, which is the same mistake the
  // closure itself used to make.
  const rim = Math.max(1, options.halfDepthPx * 0.3);

  let max = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const half = 0.5 * profile[i];
    back[i] = half;
    const taper = Math.min(1, dist[i] / rim);
    const push = options.reliefGain * (elevation[i] - datum) * taper;
    // Never let the front fall behind the centre plane: a dark or distant patch
    // may set the surface back, but it may not punch a hole through the solid.
    front[i] = Math.max(0.15 * half, half + push);
    const total = front[i] + back[i];
    if (total > max) max = total;
  }
  if (max > 0) {
    for (let i = 0; i < n; i++) {
      front[i] /= max;
      back[i] /= max;
    }
  }
  return { front, back, reliefScale: measurement.reliefScale };
}

/**
 * The fallback shape, for when the depth weights are unreachable.
 *
 * A bulge from the distance transform plus a shading cue from luminance. Both
 * are guesses and the first one dominates, so the answer is always the
 * silhouette inflated — see the note at the top of this file. Prefer
 * `depthFieldFromRelief` whenever there is a measured depth map to hand.
 */
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
  // Nothing was measured, so there is nothing to correct the prior with.
  return { front, back, reliefScale: null };
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
