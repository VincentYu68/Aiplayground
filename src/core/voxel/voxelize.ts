/**
 * Sampling the photo onto the LEGO lattice.
 *
 * The object is cropped to its silhouette so it fills the available studs, then
 * each grid column averages the pixels underneath it. Averaging (rather than
 * point sampling) matters a lot at low stud counts: it is the difference
 * between a model that keeps the object's overall tone and one that latches
 * onto whatever specular highlight happened to land on a sample point.
 */

import { deltaE2000, PALETTE, rgbToLab, type LegoColor } from '../lego/colors';
import { platesForAspect, PLATES_PER_STUD } from '../lego/units';
import { bounds, type Mask } from '../image/raster';
import { latheProfile, type DepthField } from '../image/depth';
import { nearestEdgePixel } from '../image/wrap';
import { nearestColorIndex } from '../lego/colors';
import { selectPalette, SUPPLY_PENALTY } from './quantize';
import { EMPTY, VoxelGrid } from './grid';
import type { BackTreatment, SolidMode } from '../../types';

export interface VoxelizeOptions {
  studsWide: number;
  depthScale: number;
  solidMode: SolidMode;
  backTreatment: BackTreatment;
  maxColors: number;
  /** Round the model's height to whole 3-plate courses (brick-only builds). */
  wholeCourses: boolean;
  seed: number;
}

export interface VoxelizeResult {
  grid: VoxelGrid;
  palette: LegoColor[];
  /** Silhouette on the grid, indexed [y * gridX + x] with y counting up. */
  frontMask: Uint8Array;
  /** Quantised colour index per (x, y) column, EMPTY where the column is empty. */
  frontColor: Int16Array;
  /**
   * The Lab colour actually sampled from the photo for each column, three
   * floats per column.
   *
   * Carried alongside rather than re-derived downstream on purpose. Colour
   * error used to be measured by mapping grid columns back across the whole
   * image, but the grid was sampled across the object's *bounding box* — so
   * every photo where the object did not fill the frame was scored against the
   * wrong pixels. Padding a photo with background moved the reported error on
   * an identical model from 9.6 to 17.8. Keeping the sample means the two can
   * no longer disagree.
   */
  frontLab: Float32Array;
  /** Mean CIEDE2000 error introduced by the palette reduction. */
  meanDeltaE: number;
}

/**
 * How far the colour decision may be nudged, as a fraction of the match error.
 * Small enough that it can only ever swap between two colours that were already
 * near-equally good matches.
 */
export const COURSE_COLOR_JITTER = 0.07;

/**
 * How far the front/back colour boundary shifts from course to course.
 *
 * The boundary between the photographed front and the guessed back is a colour
 * change, and no single part may cross a colour change. Left at a fixed depth
 * it becomes a flat plane running through the whole model that every course
 * has to stop at — the same stacked-joint weakness as a vertical colour band,
 * just lying on its side. Walking it a stud back and forth lets each course
 * bridge where the last one could not.
 */
const SPLIT_WALK = [0, 1, 0, -1];

/**
 * Pick a brick colour, letting the choice wander very slightly from course to
 * course.
 *
 * This looks like a cosmetic detail and is actually structural. A part can only
 * ever be one colour, so a colour boundary is a place where no part can span —
 * and if that boundary sits at the same stud on every course, the result is a
 * crack running the full height of the model, splitting it into slabs that are
 * merely leaning against each other. Photographs with broad vertical shading
 * (a vase, a bottle, a face lit from one side) produce exactly that.
 *
 * Biasing the decision by a course-dependent fraction of a percent makes the
 * boundary meander by a stud or so between courses, which is invisible — the
 * two candidate colours were within a hair of each other by definition — but
 * lets the next course's bricks reach across and tie the model together.
 */
function colorForColumn(
  lab: readonly number[],
  palette: readonly LegoColor[],
  course: number,
): { index: number; deltaE: number } {
  let best = 0;
  let bestScore = Infinity;
  let bestDelta = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const delta = deltaE2000(lab, palette[i].lab);
    // Deterministic, stable per (course, colour): no RNG state to thread.
    const hash = Math.sin(course * 12.9898 + i * 78.233) * 43758.5453;
    const jitter = 1 + COURSE_COLOR_JITTER * (2 * (hash - Math.floor(hash)) - 1);
    // The same reluctance to spend a scarce colour that chose the palette has
    // to apply when columns are assigned to it, or the penalty decides only
    // which colours are on the list and never which ones get used: Light Aqua
    // stayed at 19% of a white mug through a palette-level penalty alone.
    const score = (delta + SUPPLY_PENALTY[palette[i].supply]) * jitter;
    if (score < bestScore) {
      bestScore = score;
      bestDelta = delta;
      best = i;
    }
  }
  return { index: best, deltaE: bestDelta };
}

interface ColumnSample {
  filled: boolean;
  /** Mean colour of the object's front surface under this column. */
  r: number;
  g: number;
  b: number;
  /** Mean colour wrapped round from the nearest silhouette edge. */
  wr: number;
  wg: number;
  wb: number;
  /** Half-thickness toward the camera and away from it, each in 0..1. */
  front: number;
  back: number;
}

/**
 * The lattice the object will be sampled onto, decided once.
 *
 * The depth extent is needed in two places — here, to size the grid, and in
 * `depthFieldFromRelief`, which has to know how far the surface rolls over the
 * silhouette edge to close the volume. It used to be worked out separately in
 * each, with two different meanings, and the resulting mismatch is what turned
 * every plan view into a circle. One function, one answer, both callers.
 */
export interface GridPlan {
  box: NonNullable<ReturnType<typeof bounds>>;
  gridX: number;
  gridY: number;
  gridZ: number;
  pxPerStud: number;
  pxPerPlate: number;
}

export interface GridPlanOptions {
  studsWide: number;
  depthScale: number;
  solidMode: SolidMode;
  wholeCourses: boolean;
}

/**
 * How far the class prior may disagree with the depth map about depth.
 *
 * A relative depth map cannot state an object's thickness in millimetres --
 * that needs the camera -- so the prior is not replaced outright. But it can
 * state how much of the surface turns away from the camera, and that is enough
 * to catch the two ways the prior goes badly wrong: calling a car flat, and
 * calling a book solid.
 */
const RELIEF_DISAGREEMENT = 1.35;

/**
 * Depth as a fraction of the short axis, from how much the surface curves.
 *
 * `fraction` is the range of the *de-posed* depth map -- the part left after a
 * plane is fitted and subtracted -- over how far the object stands out from its
 * background. Taking the plane out first is what makes the number mean
 * thickness rather than tilt, and it is measured across the corpus as:
 *
 *   book 0.051   frame 0.054   gear 0.104   bottle 0.115
 *   teddy 0.220  car 0.283     mug 0.444
 *
 * which is the flat objects, then the round ones, in the right order and with a
 * real gap between them. The previous version of this measured the raw map, where
 * a book read 0.300 and a car 0.324; it could not tell a plate from a solid, and
 * a book 32 studs wide came out 32 studs deep.
 *
 * The curve is fitted to those seven and is frankly a fit to seven points: a
 * power law through "a teddy is about as deep as it is wide" at 0.22, with a
 * floor low enough that a sheet of paper is allowed to be a sheet of paper. It
 * is an honest interpolation between measured objects and nothing more, and the
 * exponent is the part to distrust first if something comes out wrong.
 */
function depthRatioFromRelief(fraction: number): number {
  return Math.max(0.08, Math.min(1.1, Math.pow(fraction / 0.24, 1.6)));
}

function bracketByRelief(ratio: number, fraction: number | null): number {
  if (fraction === null || !Number.isFinite(fraction)) return ratio;
  const measured = depthRatioFromRelief(fraction);
  return Math.max(measured / RELIEF_DISAGREEMENT, Math.min(measured * RELIEF_DISAGREEMENT, ratio));
}

/**
 * How many studs deep the model should be, among other things.
 *
 * The depth used to be `studsWide * depthScale`, i.e. the model was as deep as
 * the photograph was *wide*. That is fine for anything roughly square and absurd
 * for anything else: a car photographed side-on has "wide" equal to its length,
 * so it was extruded into a cube, and the finished model was a featureless loaf
 * whose front view happened to look like a car.
 *
 * The short axis is a far better anchor, and not by accident. Nothing much is
 * deeper than its own smallest visible dimension — a car is about as deep as it
 * is tall, a bottle about as deep as it is wide, a chair about as deep as it is
 * broad — whereas the long axis carries no information about depth at all. So
 * the extent is `min(width, height) * depthScale`, with `depthScale` meaning
 * "depth relative to the short axis" rather than to the width. For a square
 * object the two definitions agree, which is why the sphere case is unchanged.
 *
 * The class prior does not get the last word on the ratio, because it is a
 * lookup from an ImageNet label and it is wrong often enough to matter. On the
 * photorealistic car it fires "jigsaw puzzle" — archetype flat — confidently
 * enough to clear its threshold, and a 32x16 car becomes a 32x3 sheet. So the
 * depth map brackets it: see `bracketByRelief`.
 */
export function planGrid(
  mask: Mask,
  width: number,
  height: number,
  options: GridPlanOptions,
  reliefFraction: number | null,
): GridPlan | null {
  const box = bounds(mask, width, height);
  if (!box) return null;

  const gridX = Math.max(1, Math.round(options.studsWide));
  let gridY = platesForAspect(gridX, box.width, box.height);
  if (options.wholeCourses) gridY = Math.max(3, Math.ceil(gridY / 3) * 3);

  // Y counts plates and X counts studs, and a plate is not a stud tall.
  const shortAxis = Math.min(gridX, gridY / PLATES_PER_STUD);
  const ratio = bracketByRelief(Math.max(0.05, options.depthScale), reliefFraction);
  // A body of revolution takes its depth from its own radius: the silhouette
  // width *is* the diameter, and no prior gets a say.
  const gridZ =
    options.solidMode === 'revolve' ? gridX : Math.max(2, Math.round(shortAxis * ratio));

  return {
    box,
    gridX,
    gridY,
    gridZ,
    pxPerStud: box.width / gridX,
    pxPerPlate: box.height / gridY,
  };
}

/** Average the source pixels under one grid column. */
function sampleColumn(
  rgba: Uint8ClampedArray,
  mask: Mask,
  depth: DepthField,
  edgeSource: Int32Array,
  width: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): ColumnSample {
  const empty: ColumnSample = {
    filled: false,
    r: 0,
    g: 0,
    b: 0,
    wr: 0,
    wg: 0,
    wb: 0,
    front: 0,
    back: 0,
  };

  let r = 0;
  let g = 0;
  let b = 0;
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let front = 0;
  let back = 0;
  let inside = 0;
  let total = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      total++;
      if (!mask[i]) continue;
      inside++;
      const p = i * 4;
      r += rgba[p];
      g += rgba[p + 1];
      b += rgba[p + 2];

      const e = edgeSource[i];
      const ep = (e >= 0 ? e : i) * 4;
      wr += rgba[ep];
      wg += rgba[ep + 1];
      wb += rgba[ep + 2];

      front += depth.front[i];
      back += depth.back[i];
    }
  }

  if (total === 0 || inside === 0 || inside / total < 0.5) return empty;
  return {
    filled: true,
    r: r / inside,
    g: g / inside,
    b: b / inside,
    wr: wr / inside,
    wg: wg / inside,
    wb: wb / inside,
    front: front / inside,
    back: back / inside,
  };
}

/**
 * How far a shaded column is pulled toward the lit value of its own material.
 *
 * Not 1: a real object does carry some soft variation, and flattening all of it
 * makes a sphere read as a disc.
 */
const SHADING_REMOVAL = 0.85;

/** sRGB to linear light, where shading is a plain multiplier. */
function toLinear(v: number): number {
  const u = v / 255;
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function fromLinear(v: number): number {
  const u = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, u * 255));
}

/**
 * Separate the object's colour from the light falling on it.
 *
 * What the camera recorded is albedo times illumination, and only the albedo is
 * a property of the object. Quantising what the camera recorded spends the
 * palette on the lighting: the corpus mug, which is white, came out 26% Light
 * Bluish Gray, 26% Dark Bluish Gray and 21% White -- its lit side, its shaded
 * side and its mid-tone, read as three materials and laid down as contour
 * bands.
 *
 * The work happens in **linear light**, because that is the space shading is
 * simple in: a dimmer light scales all three channels by the same factor. So
 * chromaticity -- each channel over their sum -- is what survives shading, and
 * intensity is what shading changes. Doing this in Lab instead, on a and b,
 * looked reasonable and quietly failed on saturated colours: a shaded red loses
 * saturation and reads as brown, far enough from lit red in a and b to be
 * treated as a different material, so the dark red book kept its 21% Reddish
 * Brown wedge and nothing improved.
 *
 * Two assumptions, both about light rather than about the object:
 *
 * **Illumination only darkens.** Nothing makes a surface brighter than its own
 * colour except a specular highlight, so a material's *lit* intensity is the
 * best estimate of its albedo and its shaded values are that same albedo minus
 * light. Each column is pulled up toward a high percentile of its
 * neighbourhood, never down. Pulling toward the neighbourhood *average* was the
 * first attempt and it dragged the white mug body to grey, because the average
 * included the dark blue band.
 *
 * **Chromaticity identifies the material.** It is what shading leaves alone, so
 * it says which neighbours are the same stuff. Without that guard the blue band
 * would set the reference for the white body beside it and the correction would
 * paint a halo around the band.
 *
 * The neighbourhood is bounded rather than global, so two materials that happen
 * to share a chromaticity -- a car's dark windows and its black wheels -- are
 * not pooled merely because they are both neutral. They are never adjacent.
 */
function flattenShading(columns: ColumnSample[], gridX: number, gridY: number): void {
  // Wide enough to span the lit-to-shaded falloff on one surface, narrow enough
  // that separate parts of the object keep their own reference.
  const radius = Math.max(3, Math.round(Math.min(gridX, gridY) * 0.35));
  // Chromaticity runs 0..1 per channel and sums to 1, so this is a few percent
  // of the gamut: enough to hold a material together through shading, tight
  // enough to keep red away from blue.
  const CHROMA_TOLERANCE = 0.06;
  // Not the maximum: that is the specular highlight, which is not the albedo
  // either and is often nothing like the object's colour.
  const LIT_PERCENTILE = 0.8;
  // Share of a column's neighbours that must agree on its material before the
  // correction is applied in full. Interior columns clear this easily; columns
  // on the silhouette, whose colour is contaminated by the background behind
  // them, do not.
  const SUPPORT_FOR_FULL_TRUST = 0.55;

  const n = gridX * gridY;
  const cr = new Float32Array(n);
  const cg = new Float32Array(n);
  const intensity = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!columns[i].filled) continue;
    const r = toLinear(columns[i].r);
    const g = toLinear(columns[i].g);
    const b = toLinear(columns[i].b);
    const sum = r + g + b;
    intensity[i] = sum;
    // A black column has no chromaticity to speak of; treat it as neutral
    // rather than dividing by nearly nothing and getting noise.
    cr[i] = sum > 1e-4 ? r / sum : 1 / 3;
    cg[i] = sum > 1e-4 ? g / sum : 1 / 3;
  }

  const lit = new Float32Array(n);
  const litR = new Float32Array(n);
  const litG = new Float32Array(n);
  const support = new Float32Array(n);
  const nearby: number[] = [];
  for (let y = 0; y < gridY; y++) {
    for (let x = 0; x < gridX; x++) {
      const i = y * gridX + x;
      if (!columns[i].filled) continue;
      nearby.length = 0;
      let neighbours = 0;
      let chromaR = 0;
      let chromaG = 0;
      let chromaN = 1e-9;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gridY) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= gridX) continue;
          const j = yy * gridX + xx;
          if (!columns[j].filled) continue;
          neighbours++;
          const dr = cr[j] - cr[i];
          const dg = cg[j] - cg[i];
          if (Math.sqrt(dr * dr + dg * dg) > CHROMA_TOLERANCE) continue;
          nearby.push(intensity[j]);
          // Weighted toward the brighter samples: a shaded sample's hue has
          // already drifted, so it should not get an equal say in what the
          // material's hue is.
          const w = intensity[j];
          chromaR += cr[j] * w;
          chromaG += cg[j] * w;
          chromaN += w;
        }
      }
      if (nearby.length === 0) {
        lit[i] = intensity[i];
        litR[i] = cr[i];
        litG[i] = cg[i];
        continue;
      }
      nearby.sort((m, o) => m - o);
      lit[i] = nearby[Math.min(nearby.length - 1, Math.floor(nearby.length * LIT_PERCENTILE))];
      support[i] = nearby.length / Math.max(1, neighbours);
      // The consensus chromaticity of the material, not this column's own.
      // Shading desaturates a saturated colour as well as darkening it, so an
      // individual shaded sample's chromaticity is itself unreliable; the
      // group's is not.
      litR[i] = chromaR / chromaN;
      litG[i] = chromaG / chromaN;
    }
  }

  for (let i = 0; i < n; i++) {
    if (!columns[i].filled) continue;
    if (intensity[i] <= 1e-4) continue;
    // Only ever brighten: a column already above its neighbourhood's lit value
    // is the highlight, and dragging it down would invent a shadow.
    const target = Math.max(intensity[i], lit[i]);
    // How much of the neighbourhood agreed this column's material. A column in
    // the middle of a surface has most of its neighbours behind it; a column on
    // the silhouette edge averages a partly-covered stud and lands on a
    // chromaticity that is a blend of the object and whatever is behind it, so
    // almost nothing agrees with it.
    //
    // Brightening those was a visible regression and not a subtle one: a dark
    // contaminated edge quantises to dark red and disappears, and the same
    // sample brightened lands on pink or purple and reads as a deliberate
    // stripe down the side of a red car. Where the neighbourhood does not back
    // the estimate, the estimate is not acted on.
    const trust = Math.min(1, support[i] / SUPPORT_FOR_FULL_TRUST);
    const mix = SHADING_REMOVAL * trust;
    const scaled = intensity[i] + mix * (target - intensity[i]);
    // Move the hue toward the material's consensus as well as the brightness.
    // Rescaling intensity alone was a visible regression: shading desaturates
    // as well as darkens, so a shaded red's own chromaticity is already brown,
    // and brightening it without correcting that lands on Medium Nougat --
    // 14.5% of a red car, in tan, which is far more wrong than the dark red it
    // replaced.
    const rr = cr[i] + mix * (litR[i] - cr[i]);
    const gg = cg[i] + mix * (litG[i] - cg[i]);
    const bb = Math.max(0, 1 - rr - gg);
    const sum = rr + gg + bb;
    columns[i].r = fromLinear((rr / sum) * scaled);
    columns[i].g = fromLinear((gg / sum) * scaled);
    columns[i].b = fromLinear((bb / sum) * scaled);
  }
}

export function voxelize(
  rgba: Uint8ClampedArray,
  mask: Mask,
  width: number,
  height: number,
  depth: DepthField,
  options: VoxelizeOptions,
): VoxelizeResult {
  // The same plan the depth field was closed against — same function, same
  // inputs, same answer. Passing it in would be tidier, but it would also make
  // it possible for a caller to hand over a plan that disagrees.
  const plan = planGrid(mask, width, height, options, depth.reliefFraction);
  if (!plan) {
    return {
      grid: new VoxelGrid(1, 1, 1),
      palette: [PALETTE[0]],
      frontMask: new Uint8Array(1),
      frontColor: Int16Array.from([EMPTY]),
      frontLab: new Float32Array(3),
      meanDeltaE: 0,
    };
  }
  const { box, gridX, gridY, gridZ, pxPerStud, pxPerPlate } = plan;

  // Which silhouette pixel each interior pixel wraps round to, for the far side.
  const edgeSource = nearestEdgePixel(mask, width, height);

  // --- pass 1: sample every column ----------------------------------------
  const columns: ColumnSample[] = new Array(gridX * gridY);
  for (let gy = 0; gy < gridY; gy++) {
    // Grid Y counts upward; image rows count downward.
    const sy0 = box.minY + Math.floor((gridY - 1 - gy) * pxPerPlate);
    const sy1 = Math.max(sy0 + 1, box.minY + Math.ceil((gridY - gy) * pxPerPlate));
    for (let gx = 0; gx < gridX; gx++) {
      const sx0 = box.minX + Math.floor(gx * pxPerStud);
      const sx1 = Math.max(sx0 + 1, box.minX + Math.ceil((gx + 1) * pxPerStud));
      columns[gy * gridX + gx] = sampleColumn(
        rgba,
        mask,
        depth,
        edgeSource,
        width,
        Math.min(sx0, width - 1),
        Math.min(sx1, width),
        Math.min(sy0, height - 1),
        Math.min(sy1, height),
      );
    }
  }

  // --- pass 2: recover the object's colour, then choose a palette from it ---
  //
  // What the camera saw is albedo times illumination, and only the albedo is a
  // property of the object. Quantising what the camera saw spends the palette
  // on the lighting: the corpus mug, which is white, came out 26% Light Bluish
  // Gray, 26% Dark Bluish Gray and 21% White -- its lit and shaded sides, read
  // as three different colours and laid down as contour bands.
  flattenShading(columns, gridX, gridY);

  const labSamples = new Float32Array(gridX * gridY * 3);
  let sampleCount = 0;
  for (const c of columns) {
    if (!c.filled) continue;
    const [l, a, b] = rgbToLab(c.r, c.g, c.b);
    labSamples[sampleCount * 3] = l;
    labSamples[sampleCount * 3 + 1] = a;
    labSamples[sampleCount * 3 + 2] = b;
    sampleCount++;
  }
  const palette = selectPalette(labSamples, sampleCount, options.maxColors, options.seed);

  const frontMask = new Uint8Array(gridX * gridY);
  const frontColor = new Int16Array(gridX * gridY).fill(EMPTY);
  const frontLab = new Float32Array(gridX * gridY * 3);
  const backColor = new Int16Array(gridX * gridY).fill(EMPTY);
  let deltaSum = 0;
  let deltaCount = 0;
  const colorTally = new Map<number, number>();

  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (!c.filled) continue;
    frontMask[i] = 1;
    const course = Math.floor(Math.floor(i / gridX) / 3);

    const lab = rgbToLab(c.r, c.g, c.b);
    frontLab[i * 3] = lab[0];
    frontLab[i * 3 + 1] = lab[1];
    frontLab[i * 3 + 2] = lab[2];
    const { index, deltaE } = colorForColumn(lab, palette, course);
    frontColor[i] = index;
    deltaSum += deltaE;
    deltaCount++;
    colorTally.set(index, (colorTally.get(index) ?? 0) + 1);

    // The far side is only ever a guess, so it is never scored for fidelity.
    // 'wrap' is resolved after this loop, once every column has a front
    // colour to carry round. Sampling it per column from the photo read the
    // *silhouette edge pixel*, which is an anti-aliased blend of the object and
    // whatever is behind it: against the corpus car's tan backdrop that blend
    // quantised to Medium Nougat, and 14.5% of a red car came out tan because
    // the background had leaked into the model.
    backColor[i] = index;
  }

  if (options.backTreatment === 'wrap') {
    // Carry each column's colour round from the nearest column that is actually
    // on the outline, found by a breadth-first sweep inward from the silhouette.
    // The colour is one the model already uses, so the far side can never
    // introduce a colour the photograph did not contain.
    const source = new Int32Array(frontMask.length).fill(-1);
    let frontier: number[] = [];
    for (let gy = 0; gy < gridY; gy++) {
      for (let gx = 0; gx < gridX; gx++) {
        const i = gy * gridX + gx;
        if (!frontMask[i]) continue;
        const edge =
          gx === 0 ||
          gy === 0 ||
          gx === gridX - 1 ||
          gy === gridY - 1 ||
          !frontMask[i - 1] ||
          !frontMask[i + 1] ||
          !frontMask[i - gridX] ||
          !frontMask[i + gridX];
        if (edge) {
          source[i] = i;
          frontier.push(i);
        }
      }
    }
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const i of frontier) {
        const gx = i % gridX;
        const gy = (i - gx) / gridX;
        for (const [nx, ny] of [
          [gx - 1, gy],
          [gx + 1, gy],
          [gx, gy - 1],
          [gx, gy + 1],
        ]) {
          if (nx < 0 || ny < 0 || nx >= gridX || ny >= gridY) continue;
          const j = ny * gridX + nx;
          if (!frontMask[j] || source[j] >= 0) continue;
          source[j] = source[i];
          next.push(j);
        }
      }
      frontier = next;
    }
    for (let i = 0; i < frontMask.length; i++) {
      if (frontMask[i] && source[i] >= 0) backColor[i] = frontColor[source[i]];
    }
  }

  if (options.backTreatment === 'flat') {
    // One colour for the whole of the far side: the model's dominant colour,
    // which reads as a deliberate plain back rather than a smeared guess.
    let dominant = 0;
    let bestN = -1;
    for (const [index, n] of colorTally) {
      if (n > bestN) {
        bestN = n;
        dominant = index;
      }
    }
    for (let i = 0; i < backColor.length; i++) {
      if (frontMask[i]) backColor[i] = dominant;
    }
  }

  // --- pass 3: extrude into the depth axis --------------------------------
  const grid = new VoxelGrid(gridX, gridY, gridZ);

  // A body of revolution cannot describe a handle, a spout or a leaf, and
  // dropping them outright is worse than the old bug that smeared them into the
  // body: a mug without its handle is not a mug. So the lathe fills what it can
  // and reports which columns it covered, and everything the photograph shows
  // outside that is extruded from its own silhouette as usual.
  const revolved =
    options.solidMode === 'revolve'
      ? fillRevolved(grid, rgba, mask, width, height, box, palette, options, pxPerPlate)
      : null;

  {
    const centre = (gridZ - 1) / 2;
    for (let gy = 0; gy < gridY; gy++) {
      for (let gx = 0; gx < gridX; gx++) {
        const i = gy * gridX + gx;
        if (!frontMask[i]) continue;
        if (revolved && revolved[i]) continue;
        const c = columns[i];

        const total = c.front + c.back;
        const thickness = Math.max(1, Math.round(total * gridZ));
        let z0: number;
        if (options.solidMode === 'relief') {
          z0 = 0;
        } else {
          // Keep the object's own front/back split rather than centring it, so
          // shading relief pushes forward instead of fattening both sides.
          const frontShare = total > 0 ? c.front / total : 0.5;
          z0 = Math.round(centre - (thickness - 1) * frontShare);
        }
        const z1 = z0 + thickness - 1;

        // z counts back from the camera, so the front half takes the low end.
        const frontDepth = Math.max(1, Math.round(thickness * (total > 0 ? c.front / total : 0.5)));
        const course = Math.floor(gy / 3);
        const walk = SPLIT_WALK[course % SPLIT_WALK.length];
        // Clamped so neither side is squeezed out of a thin column.
        const split = Math.max(z0, Math.min(z1 - 1, z0 + frontDepth - 1 + walk));

        for (let z = Math.max(0, z0); z <= Math.min(gridZ - 1, z1); z++) {
          grid.set(gx, gy, z, z <= split ? frontColor[i] : backColor[i]);
        }
      }
    }
  }

  return {
    grid,
    palette,
    frontMask,
    frontColor,
    frontLab,
    meanDeltaE: deltaCount ? deltaSum / deltaCount : 0,
  };
}

/**
 * Rotational-symmetry mode: sweep each row's body half-width around the
 * vertical axis. For anything turned on a lathe — mugs, vases, bottles, lamps —
 * this recovers the true shape from one photo, which silhouette extrusion
 * fundamentally cannot.
 *
 * Returns which (x, y) columns the body covers, so the caller can fill in the
 * parts of the silhouette a lathe cannot reach.
 */
function fillRevolved(
  grid: VoxelGrid,
  rgba: Uint8ClampedArray,
  mask: Mask,
  width: number,
  height: number,
  box: NonNullable<ReturnType<typeof bounds>>,
  palette: LegoColor[],
  options: VoxelizeOptions,
  pxPerPlate: number,
): Uint8Array {
  void options;
  const { axis, radius: radii } = latheProfile(mask, width, height);
  const pxPerStud = box.width / grid.sx;
  const zCentre = (grid.sz - 1) / 2;
  const covered = new Uint8Array(grid.sx * grid.sy);

  const centreStuds = (axis - box.minX) / pxPerStud;

  for (let gy = 0; gy < grid.sy; gy++) {
    const sy = Math.min(
      height - 1,
      Math.max(0, Math.round(box.minY + (grid.sy - 1 - gy + 0.5) * pxPerPlate)),
    );
    const radiusStuds = radii[sy] / pxPerStud;
    if (radiusStuds < 0.4) continue;

    // One colour per height, read from the band around the axis.
    //
    // Colour used to be sampled at the matching distance from the axis, which
    // is wrong in both directions. Every voxel on the outer surface sits at the
    // full radius, so the whole body took the colour of the *silhouette edge* —
    // the grazing, most-shaded pixels in the photo — and a white mug came out
    // mid-grey. Worse, sampling that far out lands on the anti-aliased boundary,
    // where a rounded lookup falls outside the mask about half the time; the
    // voxel was then skipped entirely and the colour came from whatever sat
    // behind it, striping the band into ribbons.
    //
    // A lathe-turned object is one colour all the way round at a given height,
    // and the honest place to read it is where the surface faces the camera.
    const window = Math.max(1, radii[sy] * 0.5);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let px = Math.max(0, Math.round(axis - window)); px <= Math.min(width - 1, Math.round(axis + window)); px++) {
      const idx = sy * width + px;
      if (!mask[idx]) continue;
      r += rgba[idx * 4];
      g += rgba[idx * 4 + 1];
      b += rgba[idx * 4 + 2];
      n++;
    }
    if (n === 0) continue;
    const { index } = nearestColorIndex(rgbToLab(r / n, g / n, b / n), palette);

    for (let gz = 0; gz < grid.sz; gz++) {
      for (let gx = 0; gx < grid.sx; gx++) {
        const dx = gx + 0.5 - centreStuds;
        const dz = gz + 0.5 - (zCentre + 0.5);
        if (Math.hypot(dx, dz) > radiusStuds) continue;
        grid.set(gx, gy, gz, index);
        covered[gy * grid.sx + gx] = 1;
      }
    }
  }
  return covered;
}

/**
 * Collapse each 3-plate course to a single uniform slice so the whole model can
 * be built from bricks. Bricks are stronger, cheaper and faster to assemble
 * than the equivalent stack of plates; this trades a little vertical detail for
 * a much more robust model.
 */
export function snapToCourses(grid: VoxelGrid): VoxelGrid {
  const out = new VoxelGrid(grid.sx, grid.sy, grid.sz);
  // Round *up*: the grid is trimmed to its material before this runs, so its
  // height is only a multiple of three by luck. Flooring quietly deleted the
  // top one or two plate layers of every model whose height was not — which,
  // for a carved hull, is two times in three. The last course is simply
  // shorter than the rest, and the tiler builds it out of plates.
  const courses = Math.ceil(grid.sy / 3);
  for (let c = 0; c < courses; c++) {
    const y0 = c * 3;
    const layers = Math.min(3, grid.sy - y0);
    for (let z = 0; z < grid.sz; z++) {
      for (let x = 0; x < grid.sx; x++) {
        const votes = new Map<number, number>();
        let filled = 0;
        for (let k = 0; k < layers; k++) {
          const v = grid.get(x, y0 + k, z);
          if (v === EMPTY) continue;
          filled++;
          votes.set(v, (votes.get(v) ?? 0) + 1);
        }
        // A majority of the layers that actually exist, so a two- or one-plate
        // remainder course is judged on its own terms rather than against 3.
        if (filled * 2 < layers) continue;
        let best = EMPTY;
        let bestN = 0;
        for (const [v, n] of votes) {
          if (n > bestN) {
            bestN = n;
            best = v;
          }
        }
        for (let k = 0; k < layers; k++) out.set(x, y0 + k, z, best);
      }
    }
  }
  return out;
}
