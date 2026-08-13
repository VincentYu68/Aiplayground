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
   * How much of its standout from the background the object's own depth range
   * uses up, or null when there was no usable background. See
   * `reliefFractionFrom`; `planGrid` turns it into a depth extent.
   */
  reliefFraction: number | null;
  /**
   * The cross-section roundness actually used, after the measurement and the
   * class prior were blended. Reported so a wrong shape can be traced to the
   * decision that caused it rather than guessed at.
   */
  roundness: number;
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
 * The band over which the surface rolls over the silhouette edge, in pixels.
 *
 * Tapering over more than the silhouette's own inradius would mean the object
 * never reaches full thickness anywhere; at that point it is thinner than it is
 * deep and a full circular roll-off is the right answer anyway.
 */
function closureBand(maxDist: number, halfDepthPx: number, roundness: number): number {
  return Math.max(
    1,
    Math.min(maxDist, halfDepthPx * (0.15 + 0.85 * Math.max(0, Math.min(1, roundness)))),
  );
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
function closureProfile(dist: Float32Array, mask: Mask, band: number): Float32Array {
  const profile = new Float32Array(dist.length);
  for (let i = 0; i < dist.length; i++) {
    if (!mask[i]) continue;
    const t = Math.min(1, dist[i] / band);
    profile[i] = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  }
  return profile;
}

/**
 * How round the cross-section is, measured instead of looked up from a label.
 *
 * A convex solid and a slab differ in a way the depth map states outright: on a
 * ball, the surface falls away from the camera as you approach the outline, and
 * it does so along the circular cap the closure already models. On a box facing
 * the camera the front face is planar, so its depth has nothing to do with how
 * far a pixel is from the edge — whatever structure it has (a car's wheels and
 * windows) is unrelated to the silhouette.
 *
 * So the statistic is simply the correlation between the measured elevation and
 * the cap the object *would* have if it were round. A ball scores near 1, a flat
 * face near 0, and — usefully — a featureless object whose depth map is mostly
 * noise also scores near 0, because noise does not correlate with anything.
 *
 * It is computed over the eroded mask. The prediction bleeds outward across the
 * outline, and that bleed is itself strongly correlated with distance-to-edge:
 * left in, it would make every object look round.
 */
function measuredRoundness(
  elevation: Float32Array,
  inner: Mask,
  dist: Float32Array,
  band: number,
): number | null {
  let n = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < inner.length; i++) {
    if (!inner[i]) continue;
    const t = Math.min(1, dist[i] / band);
    sumA += elevation[i];
    sumB += Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    n++;
  }
  if (n < 256) return null;
  const meanA = sumA / n;
  const meanB = sumB / n;
  let vaa = 0;
  let vbb = 0;
  let vab = 0;
  for (let i = 0; i < inner.length; i++) {
    if (!inner[i]) continue;
    const t = Math.min(1, dist[i] / band);
    const a = elevation[i] - meanA;
    const b = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))) - meanB;
    vaa += a * a;
    vbb += b * b;
    vab += a * b;
  }
  // No variation in the template means the band covers the whole object and
  // there is no cap to compare against.
  if (vaa <= 1e-12 || vbb <= 1e-12) return null;
  return Math.max(0, Math.min(1, vab / Math.sqrt(vaa * vbb)));
}

/**
 * How much of its own standout from the background the object's depth map uses.
 *
 * Relative depth cannot be turned into a real depth without knowing the camera,
 * so this is not a measurement of the object's thickness and does not pretend to
 * be. What it can see is a ratio: the object's own disparity spread against how
 * far the object stands out from its background. A ball uses up much of that
 * gap, a poster on a wall almost none.
 *
 * Measured on the photorealistic car in `bench/out/corpus`, this reads 0.33 and
 * 0.50 on its two shots — its wheels really are proud of its doors and its
 * greenhouse really is set back. That is what a solid object with structure
 * looks like, and it is the number `planGrid` uses to decide whether a class
 * label calling the object flat is to be believed.
 *
 * Returns null when there is no usable background, which is the honest answer
 * rather than a confident number: an object that fills the frame has nothing to
 * stand out from, and a studio sweep the network reads as *near* rather than far
 * collapses the denominator.
 */
function reliefFractionFrom(
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

  return objectSpread / contrast;
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
  /**
   * The mask minus the couple of pixels at its outline where the prediction has
   * bled in from the background. Every statistic taken from the depth map uses
   * it rather than the mask itself.
   */
  inner: Mask;
  /** See `reliefFractionFrom`. */
  reliefFraction: number | null;
  /** The depth map had no range over the object: a plane facing the camera. */
  flat: boolean;
}

/**
 * Take out the part of the depth map that is the object's pose rather than its
 * shape, by fitting and subtracting a plane across it.
 *
 * Nobody photographs an object exactly square-on. At even a few degrees off, one
 * end of it is genuinely further from the camera than the other, and the depth
 * map says so — correctly. But that recession belongs to where the object was
 * standing, not to what it is, and feeding it in as relief makes the model taper
 * in *thickness* along its length: the corpus car, shot twelve degrees off
 * side-on, came out as an oval in plan when its ground truth is a rectangle. It
 * is the same failure as the original bug — a global property being read as
 * shape — one more level down.
 *
 * A plane is exactly the right thing to remove, because a plane is what a tilted
 * flat object produces. What is left is the surface's own relief: a sphere is
 * symmetric and loses nothing, and a car keeps its proud wheels and its recessed
 * greenhouse while losing the ramp along the body.
 */
function removePose(relief: Float32Array, inner: Mask, width: number): Float32Array {
  // Normal equations for z = ax + by + c over the masked pixels. Three unknowns
  // and tens of thousands of samples, so a direct solve is stable enough.
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (let i = 0; i < inner.length; i++) {
    if (!inner[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    const z = relief[i];
    n++;
    sx += x;
    sy += y;
    sz += z;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
  }
  if (n < 64) return relief;

  // Centre so the system is well conditioned; the constant term then drops out.
  const mx = sx / n;
  const my = sy / n;
  const mz = sz / n;
  const cxx = sxx - n * mx * mx;
  const cyy = syy - n * my * my;
  const cxy = sxy - n * mx * my;
  const cxz = sxz - n * mx * mz;
  const cyz = syz - n * my * mz;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < 1e-9) return relief;
  const a = (cxz * cyy - cyz * cxy) / det;
  const b = (cyz * cxx - cxz * cxy) / det;

  const out = new Float32Array(relief.length);
  for (let i = 0; i < relief.length; i++) {
    const x = i % width;
    const y = (i - x) / width;
    out[i] = relief[i] - (a * (x - mx) + b * (y - my));
  }
  return out;
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

  // Both questions are answered from the *de-posed* map, and getting that wrong
  // is what left flat objects as loaves.
  //
  // The raw range looks like the natural measure of how deep an object is, and
  // it is not, because a tilt produces range without producing thickness. A book
  // stood at an angle reads 0.300 on the raw map and a car reads 0.324: the
  // number cannot tell a plate from a solid, so a book 32 studs wide came out 32
  // studs deep. Take the plane out first and what is left is the part of the
  // surface that actually turns away from the camera -- near zero for anything
  // flat however it is posed, large for anything round.
  //
  // The contrast against the background still has to come from the raw map,
  // because the de-posed map has no background left in it to compare against.
  const scratch = new Float32Array(n);
  const shape = removePose(relief, inner, width);
  let count = 0;
  for (let i = 0; i < n; i++) if (inner[i]) scratch[count++] = shape[i];
  if (count < 16) {
    count = 0;
    for (let i = 0; i < n; i++) if (mask[i]) scratch[count++] = shape[i];
  }
  if (count === 0) return { elevation, inner, reliefFraction: null, flat: true };
  const lo = percentile(scratch, count, 0.02);
  const hi = percentile(scratch, count, 0.98);
  const span = hi - lo;
  const reliefFraction = reliefFractionFrom(relief, mask, span);

  // A depth map with no range at all is not a failed measurement, it is a
  // measurement of a plane: a surface that does not turn away from the camera
  // anywhere. Saying so is better than falling back on the class prior, and
  // safer — the failure it avoids is the pillow this whole file exists to undo.
  const flat = !(span > 1e-9);
  if (!flat) {
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      elevation[i] = Math.max(0, Math.min(1, (shape[i] - lo) / span));
    }
  } else {
    for (let i = 0; i < n; i++) if (mask[i]) elevation[i] = 0.5;
  }
  const radius = Math.max(1, Math.round(Math.min(width, height) * smoothing));
  // Smoothed *within* the mask. A plain blur mixes in the zeros outside it, so
  // the elevation sags toward the outline on every object — which pulls the
  // front surface back at the rim, and, worse, is itself perfectly correlated
  // with distance-to-edge, so a flat plate measured as 0.52 round. Dividing by
  // the blurred mask is the standard normalised convolution and removes both.
  const coverage = new Float32Array(n);
  for (let i = 0; i < n; i++) coverage[i] = mask[i] ? 1 : 0;
  const numerator = boxBlur(elevation, width, height, radius, 2);
  const denominator = boxBlur(coverage, width, height, radius, 2);
  const smoothed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    smoothed[i] = denominator[i] > 1e-6 ? numerator[i] / denominator[i] : elevation[i];
  }
  return { elevation: smoothed, inner, reliefFraction, flat };
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

  // How round the cross-section is, measured against the cap a round object
  // would have, and only *then* blended with the class prior.
  //
  // The prior is the weaker of the two and deserves the smaller share. It is a
  // lookup from an ImageNet label, and on real photographs that label clears its
  // confidence threshold rarely enough that most objects are getting the neutral
  // default rather than anything about themselves. The depth map, by contrast,
  // is about this object in this photograph. It is a blend rather than a
  // replacement only so that a user who reaches for the control still moves it.
  const measured = measuredRoundness(
    elevation,
    measurement.inner,
    dist,
    closureBand(maxDist, options.halfDepthPx, 1),
  );
  const roundness = measurement.flat
    ? 0
    : measured === null
      ? options.roundness
      : 0.3 * options.roundness + 0.7 * measured;
  const profile = closureProfile(dist, mask, closureBand(maxDist, options.halfDepthPx, roundness));

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
  return { front, back, reliefFraction: measurement.reliefFraction, roundness };
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
  // Nothing was measured, so there is nothing to bracket the prior with, and
  // the bulge's cross-section is circular by construction.
  return { front, back, reliefFraction: null, roundness: 1 };
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
