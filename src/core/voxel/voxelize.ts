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
import { centerProfile, radiusProfile } from '../image/depth';
import { nearestColorIndex } from '../lego/colors';
import { selectPalette } from './quantize';
import { EMPTY, VoxelGrid } from './grid';
import type { SolidMode } from '../../types';

export interface VoxelizeOptions {
  studsWide: number;
  depthScale: number;
  solidMode: SolidMode;
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
  /** Mean CIEDE2000 error introduced by the palette reduction. */
  meanDeltaE: number;
}

/**
 * How far the colour decision may be nudged, as a fraction of the match error.
 * Small enough that it can only ever swap between two colours that were already
 * near-equally good matches.
 */
const COURSE_COLOR_JITTER = 0.07;

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
  r: number;
  g: number;
  b: number;
  depth: number;
}

/** Average the source pixels under one grid column. */
function sampleColumn(
  rgba: Uint8ClampedArray,
  mask: Mask,
  depth: Float32Array,
  width: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): ColumnSample {
  let r = 0;
  let g = 0;
  let b = 0;
  let d = 0;
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
      d += depth[i];
    }
  }
  if (total === 0) return { filled: false, r: 0, g: 0, b: 0, depth: 0 };
  if (inside === 0 || inside / total < 0.5) {
    return { filled: false, r: 0, g: 0, b: 0, depth: 0 };
  }
  return { filled: true, r: r / inside, g: g / inside, b: b / inside, depth: d / inside };
}

export function voxelize(
  rgba: Uint8ClampedArray,
  mask: Mask,
  width: number,
  height: number,
  depth: Float32Array,
  options: VoxelizeOptions,
): VoxelizeResult {
  const box = bounds(mask, width, height);
  if (!box) {
    return {
      grid: new VoxelGrid(1, 1, 1),
      palette: [PALETTE[0]],
      frontMask: new Uint8Array(1),
      frontColor: Int16Array.from([EMPTY]),
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
  let deltaSum = 0;
  let deltaCount = 0;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (!c.filled) continue;
    frontMask[i] = 1;
    const gy = Math.floor(i / gridX);
    const { index, deltaE } = colorForColumn(rgbToLab(c.r, c.g, c.b), palette, Math.floor(gy / 3));
    frontColor[i] = index;
    deltaSum += deltaE;
    deltaCount++;
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
        const thickness = Math.max(1, Math.round(c.depth * gridZ));
        let z0: number;
        let z1: number;
        if (options.solidMode === 'relief') {
          z0 = 0;
          z1 = thickness - 1;
        } else {
          z0 = Math.round(centre - (thickness - 1) / 2);
          z1 = z0 + thickness - 1;
        }
        for (let z = Math.max(0, z0); z <= Math.min(gridZ - 1, z1); z++) {
          grid.set(gx, gy, z, frontColor[i]);
        }
      }
    }
  }

  return {
    grid,
    palette,
    frontMask,
    frontColor,
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
  const radii = radiusProfile(mask, width, height);
  const centers = centerProfile(mask, width, height);
  const pxPerStud = box.width / grid.sx;
  const zCentre = (grid.sz - 1) / 2;

  for (let gy = 0; gy < grid.sy; gy++) {
    const sy = Math.min(
      height - 1,
      Math.max(0, Math.round(box.minY + (grid.sy - 1 - gy + 0.5) * pxPerPlate)),
    );
    const radiusStuds = radii[sy] / pxPerStud;
    if (radiusStuds < 0.4) continue;
    const centreStuds = (centers[sy] - box.minX) / pxPerStud;

    for (let gz = 0; gz < grid.sz; gz++) {
      for (let gx = 0; gx < grid.sx; gx++) {
        const dx = gx + 0.5 - centreStuds;
        const dz = gz + 0.5 - (zCentre + 0.5);
        const rr = Math.hypot(dx, dz);
        if (rr > radiusStuds) continue;

        // Colour comes from the photo at the same distance from the axis,
        // averaging the two mirrored samples so lighting bias cancels out.
        const offsetPx = rr * pxPerStud;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const sx of [centers[sy] - offsetPx, centers[sy] + offsetPx]) {
          const px = Math.round(sx);
          if (px < 0 || px >= width) continue;
          const idx = sy * width + px;
          if (!mask[idx]) continue;
          r += rgba[idx * 4];
          g += rgba[idx * 4 + 1];
          b += rgba[idx * 4 + 2];
          n++;
        }
        if (n === 0) continue;
        const { index } = nearestColorIndex(rgbToLab(r / n, g / n, b / n), palette);
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
  const courses = Math.floor(grid.sy / 3);
  for (let c = 0; c < courses; c++) {
    for (let z = 0; z < grid.sz; z++) {
      for (let x = 0; x < grid.sx; x++) {
        const votes = new Map<number, number>();
        let filled = 0;
        for (let k = 0; k < 3; k++) {
          const v = grid.get(x, c * 3 + k, z);
          if (v === EMPTY) continue;
          filled++;
          votes.set(v, (votes.get(v) ?? 0) + 1);
        }
        if (filled < 2) continue;
        let best = EMPTY;
        let bestN = 0;
        for (const [v, n] of votes) {
          if (n > bestN) {
            bestN = n;
            best = v;
          }
        }
        for (let k = 0; k < 3; k++) out.set(x, c * 3 + k, z, best);
      }
    }
  }
  return out;
}
