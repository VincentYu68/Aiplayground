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
import { platesForAspect } from '../lego/units';
import { bounds, type Mask } from '../image/raster';
import { latheProfile, type DepthField } from '../image/depth';
import { nearestEdgePixel } from '../image/wrap';
import { nearestColorIndex } from '../lego/colors';
import { selectPalette } from './quantize';
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
    const score = delta * jitter;
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

export function voxelize(
  rgba: Uint8ClampedArray,
  mask: Mask,
  width: number,
  height: number,
  depth: DepthField,
  options: VoxelizeOptions,
): VoxelizeResult {
  const box = bounds(mask, width, height);
  if (!box) {
    return {
      grid: new VoxelGrid(1, 1, 1),
      palette: [PALETTE[0]],
      frontMask: new Uint8Array(1),
      frontColor: Int16Array.from([EMPTY]),
      frontLab: new Float32Array(3),
      meanDeltaE: 0,
    };
  }

  const gridX = Math.max(1, Math.round(options.studsWide));
  let gridY = platesForAspect(gridX, box.width, box.height);
  if (options.wholeCourses) gridY = Math.max(3, Math.ceil(gridY / 3) * 3);

  const gridZ =
    options.solidMode === 'revolve'
      ? gridX
      : Math.max(1, Math.round(gridX * Math.max(0.05, options.depthScale)));

  const pxPerStud = box.width / gridX;
  const pxPerPlate = box.height / gridY;

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

  // --- pass 2: choose a palette from the columns that are actually used ----
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
    backColor[i] =
      options.backTreatment === 'mirror'
        ? index
        : colorForColumn(rgbToLab(c.wr, c.wg, c.wb), palette, course).index;
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

  if (options.solidMode === 'revolve') {
    fillRevolved(grid, rgba, mask, width, height, box, palette, options, pxPerPlate);
  } else {
    const centre = (gridZ - 1) / 2;
    for (let gy = 0; gy < gridY; gy++) {
      for (let gx = 0; gx < gridX; gx++) {
        const i = gy * gridX + gx;
        if (!frontMask[i]) continue;
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
 * Rotational-symmetry mode: sweep each row's silhouette half-width around the
 * vertical axis. For anything turned on a lathe — mugs, vases, bottles, lamps —
 * this recovers the true shape from one photo, which silhouette extrusion
 * fundamentally cannot.
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
): void {
  void options;
  const { axis, radius: radii } = latheProfile(mask, width, height);
  const pxPerStud = box.width / grid.sx;
  const zCentre = (grid.sz - 1) / 2;

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
      }
    }
  }
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
