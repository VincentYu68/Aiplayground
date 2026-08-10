/**
 * Choosing which elements to place.
 *
 * This is the step that decides whether the finished model is a solid object or
 * a pile of loose bricks. Naively covering each layer with the largest possible
 * rectangles produces a model whose seams line up vertically all the way to the
 * top — a stack of independent columns that splits apart the moment you pick it
 * up. Real bricklaying solves this with a running bond, and so does this tiler:
 * every candidate placement is scored against the seams of the layer beneath
 * it, and overlapping a joint below is rewarded while reproducing it is
 * punished.
 *
 * Both halves of that matter and only one of them used to exist: see
 * BRIDGE_REWARD below.
 *
 * On top of the bond, placements are scored for:
 *   - area, so big strong parts are preferred over a carpet of 1x1s
 *   - stud overlap with the layer below, so parts are genuinely anchored
 *   - squareness, because a 2x4 resists twisting far better than a 1x8
 *
 * The search is greedy with randomised restarts and a fixed seed, so results
 * are good, fast, and reproducible.
 */

import {
  BRICK_FOOTPRINT_LIST,
  PLATE_FOOTPRINT_LIST,
  findPart,
  type Footprint,
  type PartHeight,
} from '../lego/catalog';
import { mulberry32 } from '../image/raster';
import { EMPTY, VoxelGrid } from '../voxel/grid';
import type { Placement } from '../../types';

export interface Seams {
  /** Vertical joints on X boundaries: index z * (sx + 1) + x, x in 0..sx. */
  x: Uint8Array;
  /** Vertical joints on Z boundaries: index z * sx + x, z in 0..sz. */
  z: Uint8Array;
  sx: number;
  sz: number;
}

export function emptySeams(sx: number, sz: number): Seams {
  return {
    x: new Uint8Array(sz * (sx + 1)),
    z: new Uint8Array((sz + 1) * sx),
    sx,
    sz,
  };
}

interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
  color: number;
  support: boolean;
}

/** Index of catalogue widths available for each depth, largest width first. */
function indexByDepth(list: Footprint[]): { byDepth: Map<number, number[]>; maxDepth: number; maxWidth: number } {
  const byDepth = new Map<number, number[]>();
  let maxDepth = 1;
  let maxWidth = 1;
  for (const f of list) {
    const arr = byDepth.get(f.d) ?? [];
    arr.push(f.w);
    byDepth.set(f.d, arr);
    maxDepth = Math.max(maxDepth, f.d);
    maxWidth = Math.max(maxWidth, f.w);
  }
  for (const arr of byDepth.values()) arr.sort((a, b) => b - a);
  return { byDepth, maxDepth, maxWidth };
}

const BRICK_INDEX = indexByDepth(BRICK_FOOTPRINT_LIST);
const PLATE_INDEX = indexByDepth(PLATE_FOOTPRINT_LIST);

/** Joints between neighbouring parts in a finished layer. */
export function seamsFromOwners(owner: Int32Array, sx: number, sz: number): Seams {
  const seams = emptySeams(sx, sz);
  for (let z = 0; z < sz; z++) {
    for (let x = 1; x < sx; x++) {
      const a = owner[z * sx + x - 1];
      const b = owner[z * sx + x];
      if (a >= 0 && b >= 0 && a !== b) seams.x[z * (sx + 1) + x] = 1;
    }
  }
  for (let z = 1; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const a = owner[(z - 1) * sx + x];
      const b = owner[z * sx + x];
      if (a >= 0 && b >= 0 && a !== b) seams.z[z * sx + x] = 1;
    }
  }
  return seams;
}

interface LayerContext {
  sx: number;
  sz: number;
  /** False on the build surface, where having nothing below is expected. */
  hasBelow: boolean;
  /** Occupancy of the layer below, per cell. */
  belowFilled: Uint8Array;
  /** Integral image of the occupancy of the layer below. */
  belowIntegral: Int32Array;
  /** Prefix sums of the seams below, for O(1) alignment scoring. */
  seamXPrefix: Int32Array; // (sx + 1) * (sz + 1), indexed [x * (sz + 1) + z]
  seamZPrefix: Int32Array; // (sz + 1) * (sx + 1), indexed [z * (sx + 1) + x]
  /**
   * Two-dimensional prefix sums of the same seams, so the joints a candidate
   * part covers *in its interior* can be counted in constant time as well.
   */
  seamXArea: Int32Array; // (sx + 2) * (sz + 1), indexed [bx * (sz + 1) + z]
  seamZArea: Int32Array; // (sz + 2) * (sx + 1), indexed [bz * (sx + 1) + x]
}

function buildContext(belowFilled: Uint8Array, below: Seams, sx: number, sz: number): LayerContext {
  const belowIntegral = new Int32Array((sx + 1) * (sz + 1));
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      belowIntegral[(z + 1) * (sx + 1) + (x + 1)] =
        belowFilled[z * sx + x] +
        belowIntegral[z * (sx + 1) + (x + 1)] +
        belowIntegral[(z + 1) * (sx + 1) + x] -
        belowIntegral[z * (sx + 1) + x];
    }
  }

  const seamXPrefix = new Int32Array((sx + 1) * (sz + 1));
  for (let x = 0; x <= sx; x++) {
    for (let z = 0; z < sz; z++) {
      seamXPrefix[x * (sz + 1) + z + 1] = seamXPrefix[x * (sz + 1) + z] + below.x[z * (sx + 1) + x];
    }
  }

  const seamZPrefix = new Int32Array((sz + 1) * (sx + 1));
  for (let z = 0; z <= sz; z++) {
    for (let x = 0; x < sx; x++) {
      seamZPrefix[z * (sx + 1) + x + 1] = seamZPrefix[z * (sx + 1) + x] + below.z[z * sx + x];
    }
  }

  // Same seams again, as areas: [0, bx) x [0, z).
  const seamXArea = new Int32Array((sx + 2) * (sz + 1));
  for (let bx = 0; bx <= sx; bx++) {
    for (let z = 0; z < sz; z++) {
      seamXArea[(bx + 1) * (sz + 1) + z + 1] =
        below.x[z * (sx + 1) + bx] +
        seamXArea[bx * (sz + 1) + z + 1] +
        seamXArea[(bx + 1) * (sz + 1) + z] -
        seamXArea[bx * (sz + 1) + z];
    }
  }
  const seamZArea = new Int32Array((sz + 2) * (sx + 1));
  for (let bz = 0; bz <= sz; bz++) {
    for (let x = 0; x < sx; x++) {
      seamZArea[(bz + 1) * (sx + 1) + x + 1] =
        below.z[bz * sx + x] +
        seamZArea[bz * (sx + 1) + x + 1] +
        seamZArea[(bz + 1) * (sx + 1) + x] -
        seamZArea[bz * (sx + 1) + x];
    }
  }

  return {
    sx,
    sz,
    hasBelow: belowIntegral[sz * (sx + 1) + sx] > 0,
    belowFilled,
    belowIntegral,
    seamXPrefix,
    seamZPrefix,
    seamXArea,
    seamZArea,
  };
}

function studsOnTopOfBelow(ctx: LayerContext, x: number, z: number, w: number, d: number): number {
  const { belowIntegral, sx } = ctx;
  const x0 = x;
  const x1 = x + w;
  const z0 = z;
  const z1 = z + d;
  return (
    belowIntegral[z1 * (sx + 1) + x1] -
    belowIntegral[z0 * (sx + 1) + x1] -
    belowIntegral[z1 * (sx + 1) + x0] +
    belowIntegral[z0 * (sx + 1) + x0]
  );
}

/** How much of this rect's outline reproduces a joint in the layer below. */
function alignedSeamCount(ctx: LayerContext, x: number, z: number, w: number, d: number): number {
  const { sx, sz, seamXPrefix, seamZPrefix } = ctx;
  let n = 0;
  const zSpan = (bx: number) => seamXPrefix[bx * (sz + 1) + z + d] - seamXPrefix[bx * (sz + 1) + z];
  const xSpan = (bz: number) => seamZPrefix[bz * (sx + 1) + x + w] - seamZPrefix[bz * (sx + 1) + x];
  if (x > 0) n += zSpan(x);
  if (x + w < sx) n += zSpan(x + w);
  if (z > 0) n += xSpan(z);
  if (z + d < sz) n += xSpan(z + d);
  return n;
}

/**
 * How much of the joint below this part *bridges* — a joint that falls strictly
 * inside its footprint, and is therefore held shut by it.
 *
 * This is the half of the bond that was missing. Reproducing a joint below is
 * bad and was punished; spanning one is good and was not rewarded at all. With
 * only the penalty, the cheapest way for the tiler to score well is to place
 * parts with as little boundary as possible — small ones — so it bought its
 * bond by fragmenting the model, which is close to the opposite of what a
 * running bond is for. Measured over the corpus, the penalty alone cost 31% of
 * the part count against no bond at all, and 2.5x the number of 1x1 bricks.
 */
function bridgedSeamCount(ctx: LayerContext, x: number, z: number, w: number, d: number): number {
  const { sx, sz, seamXArea, seamZArea } = ctx;
  let n = 0;
  // Joints running along X that fall between this part's own two X edges.
  if (w > 1) {
    const a = x + 1;
    const b = x + w;
    n +=
      seamXArea[b * (sz + 1) + z + d] -
      seamXArea[a * (sz + 1) + z + d] -
      seamXArea[b * (sz + 1) + z] +
      seamXArea[a * (sz + 1) + z];
  }
  if (d > 1) {
    const a = z + 1;
    const b = z + d;
    n +=
      seamZArea[b * (sx + 1) + x + w] -
      seamZArea[a * (sx + 1) + x + w] -
      seamZArea[b * (sx + 1) + x] +
      seamZArea[a * (sx + 1) + x];
  }
  return n;
}

/**
 * Scoring weights. The balance between AREA_WEIGHT, SEAM_PENALTY and
 * BRIDGE_REWARD is the whole character of the tiler: raise the first and you get
 * a model built from big parts whose joints stack into vertical cracks, raise
 * the second and you get a properly bonded model that costs a few more pieces.
 * Bond wins — a sculpture that comes apart in your hands is not cheaper in any
 * useful sense — but it should be bought by spanning joints rather than by
 * shrinking the parts, which is what the reward is for.
 *
 * The penalty is lower than it was because it no longer has to carry the bond
 * on its own: swept across the corpus, 14 sat well past the knee of its own
 * curve, paying 15% more parts than 6 for six tenths of a stability point.
 */
const AREA_WEIGHT = 4;
const SUPPORT_WEIGHT = 2.5;
const SEAM_PENALTY = 8;
const BRIDGE_REWARD = 4;
const PERIMETER_PENALTY = 0.6;

/**
 * A part with no stud under it anywhere is not a weak placement, it is an
 * impossible one — it would have to be held in mid-air. Anywhere the shape
 * flares outwards (the underside of a sphere, say) the tiler must reach back
 * over supported ground instead of laying parts into the new overhanging ring.
 * The penalty is large enough to dominate every other term, but it is a
 * penalty rather than a filter: where nothing at all has support it applies
 * equally to every candidate and simply drops out of the ranking.
 */
const NO_SUPPORT_PENALTY = 1000;

function scorePlacement(
  ctx: LayerContext,
  x: number,
  z: number,
  w: number,
  d: number,
  jitter: number,
): number {
  const area = w * d;
  const support = studsOnTopOfBelow(ctx, x, z, w, d);
  const seams = alignedSeamCount(ctx, x, z, w, d);
  const bridged = bridgedSeamCount(ctx, x, z, w, d);
  const perimeter = 2 * (w + d);
  return (
    AREA_WEIGHT * area +
    SUPPORT_WEIGHT * support -
    SEAM_PENALTY * seams +
    BRIDGE_REWARD * bridged -
    PERIMETER_PENALTY * perimeter -
    (ctx.hasBelow && support === 0 ? NO_SUPPORT_PENALTY : 0) +
    jitter
  );
}

interface TileOutcome {
  rects: Rect[];
  owner: Int32Array;
  quality: number;
}

/** Largest part the widened search will consider, per side. */
const BRIDGE_MAX_SIDE = 4;

/**
 * Find a part that covers (x, z) *and* lands on at least one stud below, by
 * trying every offset of the cell within the part rather than only the corner.
 * Only small parts are considered — this runs on the awkward cells of a layer,
 * and a 2x4 reaching one stud back over solid ground is all that is needed.
 */
function findBridgingPlacement(
  cells: Int16Array,
  owner: Int32Array,
  ctx: LayerContext,
  index: { byDepth: Map<number, number[]> },
  x: number,
  z: number,
  color: number,
  rand: () => number,
): { x: number; z: number; w: number; d: number } | null {
  const { sx, sz } = ctx;
  let best: { x: number; z: number; w: number; d: number } | null = null;
  let bestScore = -Infinity;

  for (const [d, widths] of index.byDepth) {
    if (d > BRIDGE_MAX_SIDE) continue;
    for (const w of widths) {
      if (w > BRIDGE_MAX_SIDE) continue;
      for (let oz = 0; oz < d; oz++) {
        const z0 = z - oz;
        if (z0 < 0 || z0 + d > sz) continue;
        for (let ox = 0; ox < w; ox++) {
          const x0 = x - ox;
          if (x0 < 0 || x0 + w > sx) continue;

          let fits = true;
          for (let dz = 0; dz < d && fits; dz++) {
            for (let dx = 0; dx < w; dx++) {
              const i = (z0 + dz) * sx + x0 + dx;
              if (owner[i] >= 0 || cells[i] !== color) {
                fits = false;
                break;
              }
            }
          }
          if (!fits) continue;
          if (studsOnTopOfBelow(ctx, x0, z0, w, d) === 0) continue;

          const score = scorePlacement(ctx, x0, z0, w, d, rand() * 1.5);
          if (score > bestScore) {
            bestScore = score;
            best = { x: x0, z: z0, w, d };
          }
        }
      }
    }
  }
  return best;
}

function tileOnce(
  cells: Int16Array,
  supportCells: Uint8Array,
  ctx: LayerContext,
  index: { byDepth: Map<number, number[]>; maxDepth: number; maxWidth: number },
  order: Int32Array,
  rand: () => number,
): TileOutcome {
  const { sx, sz } = ctx;
  const owner = new Int32Array(sx * sz).fill(-1);
  const rects: Rect[] = [];
  let alignedTotal = 0;
  let bridgedTotal = 0;
  let supportTotal = 0;

  for (let oi = 0; oi < order.length; oi++) {
    const start = order[oi];
    if (owner[start] >= 0) continue;
    const color = cells[start];
    if (color === EMPTY) continue;

    const x = start % sx;
    const z = (start / sx) | 0;

    let bestScore = -Infinity;
    let bestX = x;
    let bestZ = z;
    let bestW = 1;
    let bestD = 1;

    let minRun = Infinity;
    for (let d = 1; d <= index.maxDepth && z + d - 1 < sz; d++) {
      const zz = z + d - 1;
      let run = 0;
      while (x + run < sx && run < index.maxWidth) {
        const i = zz * sx + x + run;
        if (owner[i] >= 0 || cells[i] !== color) break;
        run++;
      }
      if (run === 0) break;
      if (run < minRun) minRun = run;

      const widths = index.byDepth.get(d);
      if (!widths) continue;
      for (const w of widths) {
        if (w > minRun) continue;
        const s = scorePlacement(ctx, x, z, w, d, rand() * 1.5);
        if (s > bestScore) {
          bestScore = s;
          bestX = x;
          bestZ = z;
          bestW = w;
          bestD = d;
        }
      }
    }

    if (bestScore === -Infinity) {
      // Nothing in the catalogue fits, which can only happen if 1x1 is somehow
      // unavailable; fall back to a single stud so no voxel is silently lost.
      bestW = 1;
      bestD = 1;
    }

    // Anchoring at the min corner means a cell can only ever be covered by a
    // part reaching right and back. Where a shape flares outwards — the
    // underside of anything round — the newly exposed ring sits to the *left*
    // of solid ground, and no min-corner part can reach it. When that leaves a
    // cell with nothing under it, widen the search to parts that contain the
    // cell at any offset, so the tiler can reach back over the supported area.
    if (ctx.hasBelow && studsOnTopOfBelow(ctx, bestX, bestZ, bestW, bestD) === 0) {
      const reach = findBridgingPlacement(cells, owner, ctx, index, x, z, color, rand);
      if (reach) {
        bestX = reach.x;
        bestZ = reach.z;
        bestW = reach.w;
        bestD = reach.d;
      }
    }

    const id = rects.length;
    let allSupport = true;
    for (let dz = 0; dz < bestD; dz++) {
      for (let dx = 0; dx < bestW; dx++) {
        const i = (bestZ + dz) * sx + bestX + dx;
        owner[i] = id;
        if (!supportCells[i]) allSupport = false;
      }
    }
    alignedTotal += alignedSeamCount(ctx, bestX, bestZ, bestW, bestD);
    bridgedTotal += bridgedSeamCount(ctx, bestX, bestZ, bestW, bestD);
    supportTotal += studsOnTopOfBelow(ctx, bestX, bestZ, bestW, bestD);
    rects.push({ x: bestX, z: bestZ, w: bestW, d: bestD, color, support: allSupport });
  }

  // Which restart to keep: fewer parts, fewer stacked joints, more joints held
  // shut from above, better anchored.
  const quality =
    -10 * rects.length - 6 * alignedTotal + 4 * bridgedTotal + 0.5 * supportTotal;
  return { rects, owner, quality };
}

function shuffleRange(order: Int32Array, from: number, to: number, rand: () => number): void {
  for (let i = to - 1; i > from; i--) {
    const j = from + Math.floor(rand() * (i - from + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
}

function tileLayer(
  cells: Int16Array,
  supportCells: Uint8Array,
  ctx: LayerContext,
  index: { byDepth: Map<number, number[]>; maxDepth: number; maxWidth: number },
  rand: () => number,
  restarts: number,
): TileOutcome {
  const { sx, sz } = ctx;
  const n = sx * sz;

  // Cells with nothing underneath go first. They are the constrained ones: they
  // have to reach back over solid ground, and they can only do that while their
  // supported neighbours are still free to be taken.
  const scanline = new Int32Array(n);
  let head = 0;
  for (let i = 0; i < n; i++) if (!ctx.belowFilled[i]) scanline[head++] = i;
  const unsupported = head;
  for (let i = 0; i < n; i++) if (ctx.belowFilled[i]) scanline[head++] = i;

  let best = tileOnce(cells, supportCells, ctx, index, scanline, rand);
  for (let r = 1; r < restarts; r++) {
    // Shuffle within each group, never across it: the unsupported cells must
    // keep their first pick of the supported ground next to them.
    const order = Int32Array.from(scanline);
    shuffleRange(order, 0, unsupported, rand);
    shuffleRange(order, unsupported, n, rand);
    const candidate = tileOnce(cells, supportCells, ctx, index, order, rand);
    if (candidate.quality > best.quality) best = candidate;
  }
  return best;
}

export interface TilingOptions {
  /** Prefer 3-plate bricks wherever a course is uniform. */
  useBricks: boolean;
  restarts: number;
  seed: number;
}

export interface TilingResult {
  placements: Placement[];
  /** Fraction of joints that reproduce a joint in the course below, 0..1. */
  seamAlignment: number;
}

/**
 * Convert a voxel grid into placed elements, course by course from the ground
 * up. Within a course, cells that are identical through all three plate layers
 * become bricks; anything left over is filled in with plates.
 */
/**
 * Convert a voxel grid into placed elements, course by course from the ground
 * up. Within a course, cells that are identical through all three plate layers
 * become bricks; anything left over is filled in with plates.
 *
 * Each layer records which part owns each cell, so the layer beneath is always
 * described by the parts that are actually there. That matters: a brick spans
 * three plate layers, and its joint is one joint, not three stacked ones.
 */
export function tileGrid(
  grid: VoxelGrid,
  supportMask: Uint8Array,
  palette: { ldraw: number }[],
  options: TilingOptions,
): TilingResult {
  const { sx, sy, sz } = grid;
  const n = sx * sz;
  const rand = mulberry32(options.seed);
  const placements: Placement[] = [];

  const layerOwner: Int32Array[] = [];
  for (let y = 0; y < sy; y++) layerOwner.push(new Int32Array(n).fill(-1));
  const noOwner = new Int32Array(n).fill(-1);

  let nextPartId = 0;
  let alignedTotal = 0;
  let boundaryTotal = 0;

  const toPlacements = (rects: Rect[], y: number, height: PartHeight) => {
    for (const r of rects) {
      const part = findPart(r.w, r.d, height);
      if (!part) continue;
      placements.push({
        partId: part.id,
        code: part.code,
        w: r.w,
        d: r.d,
        height,
        x: r.x,
        y,
        z: r.z,
        color: palette[r.color]?.ldraw ?? 0,
        ...(r.support ? { support: true } : {}),
      });
    }
  };

  /**
   * Place one set of parts: score it against the layer below, record who owns
   * which cell, and fold its joints into the running bond statistics.
   */
  const placeLayer = (
    cells: Int16Array,
    supportCells: Uint8Array,
    layerOccupancy: Int16Array,
    y: number,
    height: PartHeight,
    index: typeof BRICK_INDEX,
    target: Int32Array,
  ) => {
    const belowOwner = y > 0 ? layerOwner[y - 1] : noOwner;
    const belowSeams = seamsFromOwners(belowOwner, sx, sz);
    const belowFilled = ownerOccupancy(belowOwner);

    const ctx = buildContext(belowFilled, belowSeams, sx, sz);
    const result = tileLayer(cells, supportCells, ctx, index, rand, options.restarts);

    const stats = seamStats(result.rects, layerOccupancy, belowSeams, sx, sz);
    alignedTotal += stats.aligned;
    boundaryTotal += stats.boundary;

    for (let i = 0; i < n; i++) {
      if (result.owner[i] >= 0) target[i] = nextPartId + result.owner[i];
    }
    toPlacements(result.rects, y, height);
    nextPartId += result.rects.length;
  };

  const courses = Math.ceil(sy / 3);
  for (let c = 0; c < courses; c++) {
    const y0 = c * 3;
    const layerCount = Math.min(3, sy - y0);

    const layers: Int16Array[] = [];
    const supports: Uint8Array[] = [];
    for (let k = 0; k < layerCount; k++) {
      layers.push(grid.layer(y0 + k));
      const sup = new Uint8Array(n);
      const base = (y0 + k) * sz * sx;
      for (let i = 0; i < n; i++) sup[i] = supportMask[base + i];
      supports.push(sup);
    }

    // Cells that are identical through the whole course can become bricks.
    const common = new Int16Array(n).fill(EMPTY);
    const commonSupport = new Uint8Array(n);
    let hasCommon = false;
    if (options.useBricks && layerCount === 3) {
      for (let i = 0; i < n; i++) {
        const v = layers[0][i];
        if (v !== EMPTY && layers[1][i] === v && layers[2][i] === v) {
          common[i] = v;
          commonSupport[i] = supports[0][i] & supports[1][i] & supports[2][i];
          hasCommon = true;
        }
      }
    }

    const brickOwner = new Int32Array(n).fill(-1);
    if (hasCommon) {
      placeLayer(common, commonSupport, layers[0], y0, 3, BRICK_INDEX, brickOwner);
    }

    for (let k = 0; k < layerCount; k++) {
      const target = layerOwner[y0 + k];
      // A brick occupies every layer of its course.
      target.set(brickOwner);

      const remainder = new Int16Array(n).fill(EMPTY);
      const remainderSupport = new Uint8Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        if (common[i] === EMPTY && layers[k][i] !== EMPTY) {
          remainder[i] = layers[k][i];
          remainderSupport[i] = supports[k][i];
          any = true;
        }
      }
      if (any) {
        placeLayer(remainder, remainderSupport, layers[k], y0 + k, 1, PLATE_INDEX, target);
      }
    }
  }

  return {
    placements,
    seamAlignment: boundaryTotal > 0 ? alignedTotal / boundaryTotal : 0,
  };
}

function ownerOccupancy(owner: Int32Array) {
  const out = new Uint8Array(owner.length);
  for (let i = 0; i < owner.length; i++) out[i] = owner[i] >= 0 ? 1 : 0;
  return out;
}

/**
 * Measure the running bond that was actually achieved.
 *
 * Only joints that touch another part in the same layer count — the outside
 * edge of the model is not a joint — and a joint is "aligned" when the layer
 * below has a joint in the same place, which is exactly the crack a builder
 * would be able to pull apart.
 */
function seamStats(
  rects: Rect[],
  layerCells: Int16Array,
  below: Seams,
  sx: number,
  sz: number,
): { aligned: number; boundary: number } {
  let aligned = 0;
  let boundary = 0;

  for (const r of rects) {
    for (const bx of [r.x, r.x + r.w]) {
      if (bx <= 0 || bx >= sx) continue;
      const neighbourX = bx === r.x ? bx - 1 : bx;
      for (let z = r.z; z < r.z + r.d; z++) {
        if (layerCells[z * sx + neighbourX] === EMPTY) continue;
        boundary++;
        if (below.x[z * (sx + 1) + bx]) aligned++;
      }
    }
    for (const bz of [r.z, r.z + r.d]) {
      if (bz <= 0 || bz >= sz) continue;
      const neighbourZ = bz === r.z ? bz - 1 : bz;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (layerCells[neighbourZ * sx + x] === EMPTY) continue;
        boundary++;
        if (below.z[bz * sx + x]) aligned++;
      }
    }
  }

  return { aligned, boundary };
}
