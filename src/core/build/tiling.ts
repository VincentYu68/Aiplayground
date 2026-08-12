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
 *
 * Three things constrain it that a rectangle packer would not think of, and
 * they are what make the output read as a model rather than as a filled grid:
 *
 *   what exists    an element in a colour it was never moulded in is not a
 *                  placement, it is an unfillable line in someone's order. The
 *                  catalogue is filtered by colour supply before the search
 *                  starts, so it cannot pick one — see `indexFor`.
 *   what is left   scoring each part alone makes the tiler lay a 1x4 across a
 *                  five-long run and strand the fifth stud. `SLIVER_PENALTY`
 *                  and the `refine` pass exist to stop that; between them they
 *                  took 1x1 bricks from 26-52% of the corpus to 2-8%.
 *   what it is for a surface nothing will be built on gets a tile, and a step
 *                  on a diagonal gets a slope. Neither changes the volume; both
 *                  change what the model looks like.
 */

import {
  BRICKS,
  PART_BY_ID,
  PLATES,
  TILES,
  findShapePart,
  footprintsFor,
  isAvailable,
  type Footprint,
  type PartDef,
  type PartHeight,
} from '../lego/catalog';
import { COLOR_BY_LDRAW, supplySupports, type ColorSupply } from '../lego/colors';
import type { SlopeFacing } from '../lego/catalog';
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
interface SizeIndex {
  byDepth: Map<number, number[]>;
  maxDepth: number;
  maxWidth: number;
  /** `has[d * (maxWidth + 1) + w]`, so a re-cut can test a footprint in O(1). */
  has: Uint8Array;
}

function indexByDepth(list: Footprint[]): SizeIndex {
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
  const stride = maxWidth + 1;
  const has = new Uint8Array((maxDepth + 1) * stride);
  for (const f of list) has[f.d * stride + f.w] = 1;
  return { byDepth, maxDepth, maxWidth, has };
}

function catalogued(index: SizeIndex, w: number, d: number): boolean {
  if (w < 1 || d < 1 || w > index.maxWidth || d > index.maxDepth) return false;
  return index.has[d * (index.maxWidth + 1) + w] === 1;
}

/**
 * The elements a given colour may be built from.
 *
 * An element existing is not the same as an element existing in the colour you
 * want it in, and the tiler used to assume otherwise: it reached for a 1x16
 * brick as readily in a colour LEGO retired in 2004 as in White. So the
 * catalogue is filtered by supply before the tiler ever sees it, which turns
 * availability from a caveat printed after the fact into a constraint the
 * search cannot violate. See the supply note at the top of `colors.ts`.
 *
 * There are only three live tiers, so three index pairs cover every colour.
 */
const indexCache = new Map<string, SizeIndex>();

function indexFor(parts: readonly PartDef[], key: string, supply: ColorSupply): SizeIndex {
  const cacheKey = `${key}:${supply}`;
  const hit = indexCache.get(cacheKey);
  if (hit) return hit;
  const usable = parts.filter((p) => isAvailable(p, { supply }));
  const built = indexByDepth(footprintsFor(usable));
  indexCache.set(cacheKey, built);
  return built;
}

/** Colours the tiler is handed. `supply` is looked up when a caller omits it. */
export interface TilerColor {
  ldraw: number;
  supply?: ColorSupply;
}

function supplyOf(color: TilerColor | undefined): ColorSupply {
  // An unrecognised colour code is a colour nothing is known about, and the
  // safe reading of "unknown" is the narrow one: build it from small parts.
  return color?.supply ?? COLOR_BY_LDRAW.get(color?.ldraw ?? -1)?.supply ?? 'common';
}

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
 * What it costs to leave a single stud behind.
 *
 * A run of five studs has no five-long element, so the greedy takes the 1x4 and
 * the last stud can only ever be a 1x1. Splitting the same run 3 + 2 costs the
 * same two pieces and leaves no 1x1 at all — the tiler simply never saw the
 * choice, because it scored each part in isolation and a 1x4 outscores a 1x3.
 * Nothing else in the weights can express "this is fine but for what it leaves
 * behind", which is why 1x1 bricks were 28-52% of every model in the corpus
 * while a real set of the same size is in the low single digits.
 */
const SLIVER_PENALTY = 20;

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
 * Find a part that covers (x, z) by trying every offset of the cell within the
 * part rather than only the corner. Only small parts are considered — this runs
 * on the awkward cells of a layer, and a 2x4 reaching a couple of studs back
 * over solid ground is all that is needed.
 *
 * `requireSupport` is set when the cell has nothing underneath it and the point
 * of the search is to reach back over ground that has.
 */
function findReachingPlacement(
  cells: Int16Array,
  owner: Int32Array,
  ctx: LayerContext,
  index: SizeIndex,
  x: number,
  z: number,
  color: number,
  requireSupport: boolean,
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
          if (requireSupport && studsOnTopOfBelow(ctx, x0, z0, w, d) === 0) continue;

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

/** Write a rect's id into the owner map and report whether it is all support. */
function claim(r: Rect, id: number, owner: Int32Array, supportCells: Uint8Array, sx: number): void {
  let allSupport = true;
  for (let dz = 0; dz < r.d; dz++) {
    for (let dx = 0; dx < r.w; dx++) {
      const i = (r.z + dz) * sx + r.x + dx;
      owner[i] = id;
      if (!supportCells[i]) allSupport = false;
    }
  }
  r.support = allSupport;
}

function tileOnce(
  cells: Int16Array,
  supportCells: Uint8Array,
  ctx: LayerContext,
  indexes: SizeIndex[],
  awkward: Uint8Array,
  order: Int32Array,
  rand: () => number,
): TileOutcome {
  const { sx, sz } = ctx;
  const owner = new Int32Array(sx * sz).fill(-1);
  const rects: Rect[] = [];

  for (let oi = 0; oi < order.length; oi++) {
    const start = order[oi];
    if (owner[start] >= 0) continue;
    const color = cells[start];
    if (color === EMPTY) continue;
    const index = indexes[color] ?? indexes[0];

    const x = start % sx;
    const z = (start / sx) | 0;

    let bestScore = -Infinity;
    let bestX = x;
    let bestZ = z;
    let bestW = 1;
    let bestD = 1;

    let minRun = Infinity;
    let minRunBlocked = false;
    for (let d = 1; d <= index.maxDepth && z + d - 1 < sz; d++) {
      const zz = z + d - 1;
      let run = 0;
      while (x + run < sx && run < index.maxWidth) {
        const i = zz * sx + x + run;
        if (owner[i] >= 0 || cells[i] !== color) break;
        run++;
      }
      if (run === 0) break;
      if (run < minRun) {
        minRun = run;
        // Whether the run stopped because it hit something or because the
        // catalogue ran out. Only the first kind can leave a stranded stud.
        minRunBlocked = run < index.maxWidth;
      }

      const widths = index.byDepth.get(d);
      if (!widths) continue;
      for (const w of widths) {
        if (w > minRun) continue;
        const sliver = minRunBlocked && minRun - w === 1 ? SLIVER_PENALTY * d : 0;
        const s = scorePlacement(ctx, x, z, w, d, rand() * 1.5) - sliver;
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
    // part reaching right and back. Two different things go wrong because of
    // that, and both are fixed by widening the search to parts that contain the
    // cell at any offset:
    //
    //  - Where a shape flares outwards — the underside of anything round — the
    //    newly exposed ring sits to the *left* of solid ground, and no
    //    min-corner part can reach it, so the part ends up with nothing under it.
    //  - On any organic outline the cells at the +x/+z edge of the shape have a
    //    run of one in both directions, so the corner anchor can only ever offer
    //    them a 1x1. That fringe is where the pixel-sculpture look comes from,
    //    and reaching back over the interior collapses it.
    const unsupported = ctx.hasBelow && studsOnTopOfBelow(ctx, bestX, bestZ, bestW, bestD) === 0;
    if (unsupported || (bestW === 1 && bestD === 1 && awkward[start])) {
      const reach = findReachingPlacement(
        cells,
        owner,
        ctx,
        index,
        x,
        z,
        color,
        unsupported,
        rand,
      );
      if (reach) {
        bestX = reach.x;
        bestZ = reach.z;
        bestW = reach.w;
        bestD = reach.d;
      }
    }

    const rect: Rect = { x: bestX, z: bestZ, w: bestW, d: bestD, color, support: false };
    claim(rect, rects.length, owner, supportCells, sx);
    rects.push(rect);
  }

  refine(rects, owner, ctx, indexes, supportCells);
  return { rects, owner, quality: qualityOf(rects, ctx) };
}

/** Which restart to keep: fewer parts, fewer stranded studs, better bonded. */
function qualityOf(rects: Rect[], ctx: LayerContext): number {
  let aligned = 0;
  let bridged = 0;
  let support = 0;
  let ones = 0;
  for (const r of rects) {
    aligned += alignedSeamCount(ctx, r.x, r.z, r.w, r.d);
    bridged += bridgedSeamCount(ctx, r.x, r.z, r.w, r.d);
    support += studsOnTopOfBelow(ctx, r.x, r.z, r.w, r.d);
    if (r.w === 1 && r.d === 1) ones++;
  }
  return -10 * rects.length - 6 * aligned + 4 * bridged + 0.5 * support - 12 * ones;
}

/**
 * Second thoughts, once the whole layer is on the table.
 *
 * The greedy places one part at a time and can only judge it against what is
 * already down, so it routinely lays a 1x4 that strands the fifth stud of a
 * five-long run. Both passes here are exact re-partitions of cells that are
 * already covered — the same studs, cut differently — so neither can change the
 * shape of the model, lose a voxel, or put one part across a colour boundary.
 *
 *   merge     two neighbours that together make a catalogued element become it
 *   recut     a stranded 1x1 and its neighbour are re-cut into two parts that
 *             are both bigger than one stud
 *
 * The second is the one that matters. It costs nothing at all — two parts in,
 * two parts out — and it is the difference between a run of five reading as
 * "3 + 2" and as "4 + a loose stud".
 */
function refine(
  rects: Rect[],
  owner: Int32Array,
  ctx: LayerContext,
  indexes: SizeIndex[],
  supportCells: Uint8Array,
): void {
  const { sx, sz } = ctx;
  const dead = new Uint8Array(rects.length);

  const indexOf = (color: number) => indexes[color] ?? indexes[0];
  const neighbourAt = (x: number, z: number): number =>
    x < 0 || z < 0 || x >= sx || z >= sz ? -1 : owner[z * sx + x];

  // A re-cut may not put a part somewhere it would have to be held in mid-air.
  const supported = (x: number, z: number, w: number, d: number) =>
    !ctx.hasBelow || studsOnTopOfBelow(ctx, x, z, w, d) > 0;

  for (let round = 0; round < 3; round++) {
    let changed = false;

    for (let i = 0; i < rects.length; i++) {
      if (dead[i]) continue;
      const r = rects[i];
      const index = indexOf(r.color);

      // --- merge: r and the neighbour past its far edge make one element -----
      for (const along of [0, 1]) {
        const j = along === 0 ? neighbourAt(r.x + r.w, r.z) : neighbourAt(r.x, r.z + r.d);
        if (j < 0 || j === i || dead[j]) continue;
        const s = rects[j];
        if (s.color !== r.color) continue;
        const fits =
          along === 0
            ? s.z === r.z && s.d === r.d && s.x === r.x + r.w
            : s.x === r.x && s.w === r.w && s.z === r.z + r.d;
        if (!fits) continue;
        const w = along === 0 ? r.w + s.w : r.w;
        const d = along === 0 ? r.d : r.d + s.d;
        if (!catalogued(index, w, d)) continue;
        r.w = w;
        r.d = d;
        dead[j] = 1;
        claim(r, i, owner, supportCells, sx);
        changed = true;
      }
    }

    // --- recut: no part should be one stud when its neighbour can spare one --
    for (let i = 0; i < rects.length; i++) {
      if (dead[i]) continue;
      const r = rects[i];
      if (r.w !== 1 || r.d !== 1) continue;
      const index = indexOf(r.color);

      for (const [dx, dz] of NEIGHBOURS) {
        const j = neighbourAt(r.x + dx, r.z + dz);
        if (j < 0 || j === i || dead[j]) continue;
        const s = rects[j];
        if (s.color !== r.color) continue;
        if (recut(r, s, i, j, dx !== 0, index, owner, supportCells, supported, sx)) {
          changed = true;
          break;
        }
      }
    }

    if (!changed) break;
  }

  // Compact, and renumber the owner map to match.
  let head = 0;
  const remap = new Int32Array(rects.length).fill(-1);
  for (let i = 0; i < rects.length; i++) {
    if (dead[i]) continue;
    remap[i] = head;
    rects[head++] = rects[i];
  }
  rects.length = head;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] >= 0) owner[i] = remap[owner[i]];
  }

  dissolveStrays(rects, owner, indexOf, supportCells, supported, neighbourAt, sx);
}

const NEIGHBOURS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
}

function box(x: number, z: number, w: number, d: number): Box {
  return { x, z, w, d };
}

/**
 * Re-cut a stranded 1x1 and the neighbour it touches into two better parts.
 *
 * Two shapes of union are worth handling, and between them they cover most of
 * the stranded studs in a real model:
 *
 *   a run    the 1x1 sits on the end of a run in line with it, so the union is
 *            a run of N+1 that no single element covers. Splitting it anywhere
 *            other than N + 1 removes the stray at no cost at all.
 *   a corner the 1x1 sits against the end of one of the neighbour's faces. Peel
 *            off the row or column it is in, one stud longer, and leave the
 *            rest of the block behind.
 *
 * Both are free: two parts in, two parts out. What they cannot reach —
 * a stray beside a 2x4, where the peeled row would be five studs and no
 * five-long element exists — is left to `dissolveStrays`, which can spend a
 * piece on it.
 *
 * `alongX` says whether the neighbour is beside the 1x1 along X or along Z,
 * which fixes which face of the neighbour is involved; deriving it from the
 * coordinates gets it wrong for a neighbour that wraps around a corner.
 *
 * Returns true when the pair was re-cut. Both outputs are always catalogued,
 * available in the colour, and resting on something.
 */
function recut(
  r: Rect,
  s: Rect,
  ri: number,
  si: number,
  alongX: boolean,
  index: SizeIndex,
  owner: Int32Array,
  supportCells: Uint8Array,
  supported: (x: number, z: number, w: number, d: number) => boolean,
  sx: number,
): boolean {
  // Geometry only: the colour and the support flag belong to the rect, not to
  // the shape it is being re-cut into.
  const commit = (a: Box, b: Box): boolean => {
    if (!catalogued(index, a.w, a.d) || !catalogued(index, b.w, b.d)) return false;
    if (!supported(a.x, a.z, a.w, a.d) || !supported(b.x, b.z, b.w, b.d)) return false;
    adopt(r, a);
    adopt(s, b);
    claim(r, ri, owner, supportCells, sx);
    claim(s, si, owner, supportCells, sx);
    return true;
  };

  /** Split a run of `total` studs as evenly as the catalogue allows. */
  const splitRun = (x0: number, z0: number, total: number): boolean => {
    for (let a = total >> 1; a >= 2; a--) {
      const b = total - a;
      if (b < 2) break;
      const first = alongX ? box(x0, z0, a, 1) : box(x0, z0, 1, a);
      const second = alongX ? box(x0 + a, z0, b, 1) : box(x0, z0 + a, 1, b);
      if (commit(first, second)) return true;
    }
    return false;
  };

  if (alongX) {
    // In line: the neighbour is one deep and shares the 1x1's row.
    if (s.d === 1 && s.z === r.z) return splitRun(Math.min(r.x, s.x), r.z, s.w + 1);
    // At a corner: peel off the 1x1's row, one stud longer.
    if (s.d >= 2 && (r.z === s.z || r.z === s.z + s.d - 1)) {
      const strip = box(Math.min(r.x, s.x), r.z, s.w + 1, 1);
      const rest = box(s.x, r.z === s.z ? s.z + 1 : s.z, s.w, s.d - 1);
      return commit(strip, rest);
    }
    return false;
  }

  if (s.w === 1 && s.x === r.x) return splitRun(r.x, Math.min(r.z, s.z), s.d + 1);
  if (s.w >= 2 && (r.x === s.x || r.x === s.x + s.w - 1)) {
    const strip = box(r.x, Math.min(r.z, s.z), 1, s.d + 1);
    const rest = box(r.x === s.x ? s.x + 1 : s.x, s.z, s.w - 1, s.d);
    return commit(strip, rest);
  }
  return false;
}

/**
 * The last resort for a stud that nothing free could absorb.
 *
 * What survives `recut` is a 1x1 whose union with its neighbour has no
 * two-rectangle cut at all: a stray beside a 2x4, where the row it joins would
 * be five studs and no five-long element exists, or a stray against the middle
 * of a long face. Both do have a *three*-rectangle cut, and taking it costs one
 * extra piece.
 *
 * That is a real trade and it is worth making. A model is judged on whether it
 * looks like something a designer built, and nothing says "filled in from a
 * voxel grid" louder than a carpet of single studs; one part in fifty is a
 * cheap price for removing most of them. It runs last, on the strays that
 * survived every free option, and it never accepts a cut that costs more than
 * the one piece or that would strand a fresh single stud of its own.
 */
function dissolveStrays(
  rects: Rect[],
  owner: Int32Array,
  indexOf: (color: number) => SizeIndex,
  supportCells: Uint8Array,
  supported: (x: number, z: number, w: number, d: number) => boolean,
  neighbourAt: (x: number, z: number) => number,
  sx: number,
): void {
  const initial = rects.length;
  for (let i = 0; i < initial; i++) {
    const r = rects[i];
    if (r.w !== 1 || r.d !== 1) continue;
    const index = indexOf(r.color);

    for (const [dx, dz] of NEIGHBOURS) {
      const j = neighbourAt(r.x + dx, r.z + dz);
      if (j < 0 || j === i) continue;
      const s = rects[j];
      if (s.color !== r.color) continue;
      const alongX = dx !== 0;

      // Slice the union into the band the stray joins, plus what is left of the
      // neighbour on either side of it. Each band is one or two parts.
      const bands: Array<Box | null> = alongX
        ? [
            box(Math.min(r.x, s.x), r.z, s.w + 1, 1),
            box(s.x, s.z, s.w, r.z - s.z),
            box(s.x, r.z + 1, s.w, s.z + s.d - r.z - 1),
          ]
        : [
            box(r.x, Math.min(r.z, s.z), 1, s.d + 1),
            box(s.x, s.z, r.x - s.x, s.d),
            box(r.x + 1, s.z, s.x + s.w - r.x - 1, s.d),
          ];

      const parts: Box[] = [];
      let ok = true;
      for (const band of bands) {
        if (!band || band.w <= 0 || band.d <= 0) continue;
        const cover = coverBand(index, band, alongX);
        if (!cover) {
          ok = false;
          break;
        }
        parts.push(...cover);
      }
      // Two parts in, at most three out, and every one of them placeable.
      if (!ok || parts.length < 2 || parts.length > 3) continue;
      if (!parts.every((b) => supported(b.x, b.z, b.w, b.d))) continue;

      adopt(r, parts[0]);
      adopt(s, parts[1]);
      claim(r, i, owner, supportCells, sx);
      claim(s, j, owner, supportCells, sx);
      for (let k = 2; k < parts.length; k++) {
        const grown: Rect = { ...parts[k], color: r.color, support: false };
        claim(grown, rects.length, owner, supportCells, sx);
        rects.push(grown);
      }
      break;
    }
  }
}

function adopt(r: Rect, b: Box): void {
  r.x = b.x;
  r.z = b.z;
  r.w = b.w;
  r.d = b.d;
}

/**
 * Cover a band with one catalogued element, or two if no single one fits.
 * Never returns a piece one stud long — the whole point is to stop making them.
 */
function coverBand(index: SizeIndex, band: Box, alongX: boolean): Box[] | null {
  if (catalogued(index, band.w, band.d)) return [band];
  const total = alongX ? band.w : band.d;
  for (let a = total >> 1; a >= 2; a--) {
    const b = total - a;
    if (b < 2) break;
    for (const [p, q] of [
      [a, b],
      [b, a],
    ]) {
      const first = alongX ? box(band.x, band.z, p, band.d) : box(band.x, band.z, band.w, p);
      const second = alongX
        ? box(band.x + p, band.z, q, band.d)
        : box(band.x, band.z + p, band.w, q);
      if (catalogued(index, first.w, first.d) && catalogued(index, second.w, second.d)) {
        return [first, second];
      }
    }
  }
  return null;
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
  indexes: SizeIndex[],
  rand: () => number,
  restarts: number,
): TileOutcome {
  const { sx, sz } = ctx;
  const n = sx * sz;

  // Cells the corner-anchored search cannot do anything with: the run to the
  // right and the run backwards are both one, so the biggest part it can offer
  // is a single stud. On an organic outline these are the whole +x/+z fringe.
  const awkward = new Uint8Array(n);
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const i = z * sx + x;
      const c = cells[i];
      if (c === EMPTY) continue;
      const right = x + 1 < sx && cells[i + 1] === c;
      const back = z + 1 < sz && cells[i + sx] === c;
      if (!right && !back) awkward[i] = 1;
    }
  }

  // Cells with nothing underneath go first, then the awkward ones. Both are
  // constrained: they have to reach back over ground that is still free, and
  // they can only do that while their neighbours have not been taken.
  const scanline = new Int32Array(n);
  let head = 0;
  for (let i = 0; i < n; i++) if (!ctx.belowFilled[i]) scanline[head++] = i;
  const unsupported = head;
  for (let i = 0; i < n; i++) if (ctx.belowFilled[i] && awkward[i]) scanline[head++] = i;
  const fringe = head;
  for (let i = 0; i < n; i++) if (ctx.belowFilled[i] && !awkward[i]) scanline[head++] = i;

  let best = tileOnce(cells, supportCells, ctx, indexes, awkward, scanline, rand);
  for (let r = 1; r < restarts; r++) {
    // Shuffle within each group, never across it: the constrained cells must
    // keep their first pick of the ground next to them.
    const order = Int32Array.from(scanline);
    shuffleRange(order, 0, unsupported, rand);
    shuffleRange(order, unsupported, fringe, rand);
    shuffleRange(order, fringe, n, rand);
    const candidate = tileOnce(cells, supportCells, ctx, indexes, awkward, order, rand);
    if (candidate.quality > best.quality) best = candidate;
  }
  return best;
}

export interface TilingOptions {
  /** Prefer 3-plate bricks wherever a course is uniform. */
  useBricks: boolean;
  /**
   * Finish large upward-facing surfaces with tiles. On by default: a studded
   * surface says "this is the top of a stack of bricks" and a tiled one says
   * "this is the top of the object", and that is most of the difference
   * between a model that reads as designed and one that reads as filled in.
   */
  useTiles?: boolean;
  /**
   * Put a slope on a stepped diagonal instead of leaving the step square. On
   * by default: whether the diagonals are stepped or sloped is most of what
   * decides whether a model reads as LEGO or as Minecraft.
   */
  useSlopes?: boolean;
  restarts: number;
  seed: number;
}

/**
 * How broad a flat upward-facing area has to be before it is worth tiling.
 *
 * Measured on the area left after shrinking the region by one stud on every
 * side, which is the test that matters. The first attempt at this used the raw
 * area, and on a curved model the one-stud-wide ledge that rings every course
 * clears any area threshold you like — so most of the model turned from a brick
 * course into three layers of small plates. Part counts went up by half and the
 * mug came apart into three assemblies, because the bonding that held the model
 * together was the bricks that had just been taken out of it.
 *
 * Requiring the region to survive an erosion says "at least three studs across
 * in both directions with real interior", which is the difference between a
 * book cover and the step of a curve. A designer tiles the first and leaves the
 * second studded.
 */
const MIN_FINISHED_AREA = 24;

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
  palette: TilerColor[],
  options: TilingOptions,
): TilingResult {
  const { sx, sy, sz } = grid;
  const n = sx * sz;
  const rand = mulberry32(options.seed);
  const placements: Placement[] = [];

  // What each colour in this model may actually be built from. A colour that is
  // only made in small parts constrains the search rather than being noted
  // afterwards, which is the whole point: the tiler cannot pick a 1x16 in a
  // colour it was never moulded in, because it is not in the list.
  const colorSupply = palette.map((c) => supplyOf(c));
  // Placements carry an LDraw code, not a palette slot, and the slope pass runs
  // on placements.
  const ldrawToIndex = new Map(palette.map((c, i) => [c.ldraw, i]));
  const paletteIndexOf = (ldraw: number) => ldrawToIndex.get(ldraw) ?? 0;
  const brickIndexes = palette.map((c) => indexFor(BRICKS, 'brick', supplyOf(c)));
  const plateIndexes = palette.map((c) => indexFor(PLATES, 'plate', supplyOf(c)));
  const tileIndexes = palette.map((c) => indexFor(TILES, 'tile', supplyOf(c)));

  // Highest filled plate layer in each column, so a course can tell whether it
  // is the top of the model there or merely has a cavity over it.
  const highest = new Int32Array(n).fill(-1);
  for (let y = 0; y < sy; y++) {
    const base = y * sz * sx;
    for (let i = 0; i < n; i++) if (grid.cells[base + i] !== EMPTY) highest[i] = y;
  }

  const layerOwner: Int32Array[] = [];
  for (let y = 0; y < sy; y++) layerOwner.push(new Int32Array(n).fill(-1));
  const noOwner = new Int32Array(n).fill(-1);

  let nextPartId = 0;
  let alignedTotal = 0;
  let boundaryTotal = 0;

  const toPlacements = (
    rects: Rect[],
    y: number,
    height: PartHeight,
    shape: 'brick' | 'plate' | 'tile',
  ) => {
    for (const r of rects) {
      const part = findShapePart(shape, r.w, r.d);
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
    shape: 'brick' | 'plate' | 'tile',
    indexes: SizeIndex[],
    target: Int32Array,
  ) => {
    const belowOwner = y > 0 ? layerOwner[y - 1] : noOwner;
    const belowSeams = seamsFromOwners(belowOwner, sx, sz);
    const belowFilled = ownerOccupancy(belowOwner);

    const ctx = buildContext(belowFilled, belowSeams, sx, sz);
    const result = tileLayer(cells, supportCells, ctx, indexes, rand, options.restarts);

    const stats = seamStats(result.rects, layerOccupancy, belowSeams, sx, sz);
    alignedTotal += stats.aligned;
    boundaryTotal += stats.boundary;

    for (let i = 0; i < n; i++) {
      if (result.owner[i] >= 0) target[i] = nextPartId + result.owner[i];
    }
    toPlacements(result.rects, y, height, shape);
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

    const aboveCourse = y0 + 3 < sy ? grid.layer(y0 + 3) : null;

    // Which cells of this course are a finished top surface: full height
    // through the course, nothing above them, and part of an area big enough to
    // read as a surface. Those are built as two plates and a tile rather than
    // as a brick — which is what the top of a real model looks like, and, since
    // plates come in footprints up to 8x16 and the biggest brick is 2x10, is
    // very nearly free.
    const finish =
      options.useTiles !== false && layerCount === 3
        ? finishedTopSurface(layers, supports, highest, y0, sx, sz)
        : null;

    // Cells that are identical through the whole course can become bricks.
    const common = new Int16Array(n).fill(EMPTY);
    const commonSupport = new Uint8Array(n);
    let hasCommon = false;
    if (options.useBricks && layerCount === 3) {
      for (let i = 0; i < n; i++) {
        if (finish && finish[i]) continue;
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
      const firstBrick = placements.length;
      placeLayer(common, commonSupport, layers[0], y0, 3, 'brick', brickIndexes, brickOwner);
      if (options.useSlopes !== false && y0 > 0) {
        applySlopes(
          placements,
          firstBrick,
          grid,
          layers[0],
          aboveCourse,
          y0,
          sx,
          sz,
          colorSupply,
          paletteIndexOf,
        );
      }
    }

    for (let k = 0; k < layerCount; k++) {
      const target = layerOwner[y0 + k];
      // A brick occupies every layer of its course.
      target.set(brickOwner);
      // Only the top plate of the course gets tiled; the two under it are
      // ordinary plates carrying the studs the tile clips onto.
      const tiled = finish && k === layerCount - 1 ? finish : null;

      const remainder = new Int16Array(n).fill(EMPTY);
      const remainderSupport = new Uint8Array(n);
      const surface = new Int16Array(n).fill(EMPTY);
      const surfaceSupport = new Uint8Array(n);
      let any = false;
      let anySurface = false;
      for (let i = 0; i < n; i++) {
        if (common[i] !== EMPTY || layers[k][i] === EMPTY) continue;
        if (tiled && tiled[i]) {
          surface[i] = layers[k][i];
          surfaceSupport[i] = supports[k][i];
          anySurface = true;
        } else {
          remainder[i] = layers[k][i];
          remainderSupport[i] = supports[k][i];
          any = true;
        }
      }
      if (any) {
        placeLayer(remainder, remainderSupport, layers[k], y0 + k, 1, 'plate', plateIndexes, target);
      }
      if (anySurface) {
        placeLayer(surface, surfaceSupport, layers[k], y0 + k, 1, 'tile', tileIndexes, target);
      }
    }
  }

  return {
    placements,
    seamAlignment: boundaryTotal > 0 ? alignedTotal / boundaryTotal : 0,
  };
}

/**
 * Cells of a course that are worth finishing with a tile.
 *
 * A cell qualifies when the course is solid and one colour all the way through
 * it, nothing sits above it, and it is not scaffolding — you do not decorate a
 * strut. Qualifying cells are then grouped, and groups smaller than
 * `MIN_FINISHED_AREA` are dropped: an isolated ledge on a curve is a step, not
 * a surface, and tiling it would flatten exactly the texture that makes a
 * sculpted model read as sculpted.
 */
function finishedTopSurface(
  layers: Int16Array[],
  supports: Uint8Array[],
  highest: Int32Array,
  y0: number,
  sx: number,
  sz: number,
): Uint8Array | null {
  const n = sx * sz;
  const candidate = new Uint8Array(n);
  let anyCandidate = false;
  for (let i = 0; i < n; i++) {
    const v = layers[0][i];
    if (v === EMPTY || layers[1][i] !== v || layers[2][i] !== v) continue;
    // Nothing above anywhere in this column, not merely nothing in the next
    // course. Every model thick enough is hollowed out, and the floor of that
    // cavity is "top exposed" by the local test while being both invisible and
    // load-bearing: finishing it cost the bond that held the shell's bottom cap
    // to its wall, and the end-to-end sphere came apart into two pieces.
    if (highest[i] !== y0 + 2) continue;
    if (supports[0][i] || supports[1][i] || supports[2][i]) continue;
    candidate[i] = 1;
    anyCandidate = true;
  }
  if (!anyCandidate) return null;

  // Keep only groups that are big enough, and only where the group is one
  // colour: a tile cannot straddle a colour boundary any more than a brick can,
  // and a two-tone surface is better served by leaving the boundary to the
  // plates underneath.
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const group: number[] = [];
  let kept = false;
  for (let start = 0; start < n; start++) {
    if (!candidate[start] || seen[start]) continue;
    const color = layers[0][start];
    group.length = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      group.push(i);
      const x = i % sx;
      const z = (i / sx) | 0;
      if (x > 0) push(i - 1);
      if (x + 1 < sx) push(i + 1);
      if (z > 0) push(i - sx);
      if (z + 1 < sz) push(i + sx);
    }
    if (group.length >= MIN_FINISHED_AREA && erodedArea(group, candidate, sx, sz) >= MIN_FINISHED_AREA) {
      for (const i of group) out[i] = 1;
      kept = true;
    }

    function push(j: number): void {
      if (seen[j] || !candidate[j] || layers[0][j] !== color) return;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return kept ? out : null;
}

/**
 * Turn the steps on a diagonal surface into slopes.
 *
 * A model built out of whole courses climbs a curve as a staircase, and a
 * staircase is the single loudest thing that says "this came out of a voxel
 * grid". A real designer puts a slope on it.
 *
 * This runs *after* the course has been tiled and only ever swaps one element
 * for another of the same footprint in the same place. That matters more than
 * it looks: planning slopes first, and taking their studs out of the tiler's
 * hands, cut two-stud bites out of the edge of every course and stranded the
 * studs between them — slopes reached a third of the part count and the 1x1
 * share went back over the bar it had just cleared. Swapping instead is free by
 * construction: same parts, same volume, same silhouette.
 *
 * The conditions are narrow, because a slope in the wrong place is worse than a
 * step:
 *
 *   - the brick has to be at the outer edge of its course, lying with its long
 *     axis pointing outward, so the element's ramp is where the step is;
 *   - the course below has to reach exactly one stud further out. One stud per
 *     course is what a 45 degree slope *is*; on a vertical wall there is no
 *     diagonal to smooth, and on a shallower curve a 45 degree face would stand
 *     proud of the surface it is meant to follow;
 *   - nothing may sit on the ramp, because the ramp has no studs.
 */
function applySlopes(
  placements: Placement[],
  from: number,
  grid: VoxelGrid,
  layer: Int16Array,
  aboveCourse: Int16Array | null,
  y0: number,
  sx: number,
  sz: number,
  colorSupply: ColorSupply[],
  colorOf: (ldraw: number) => number,
): void {
  const filled = (i: number) => layer[i] !== EMPTY;
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < sx && z < sz;

  for (let k = from; k < placements.length; k++) {
    const p = placements[k];
    if (p.height !== 3 || p.support) continue;
    const long = Math.max(p.w, p.d);
    const short = Math.min(p.w, p.d);
    if (short > 2 || long < 2 || long > 4) continue;
    if (short === 1 && long !== 2) continue;

    for (const [dx, dz, facing] of SLOPE_DIRS) {
      // The element's ramp runs along its own long axis, so the step has to be
      // off the long end.
      if (dx !== 0 ? p.w !== long : p.d !== long) continue;

      const edge = dx > 0 || dz > 0 ? (dx !== 0 ? p.x + p.w : p.z + p.d) : (dx !== 0 ? p.x - 1 : p.z - 1);
      const rampAt = dx > 0 || dz > 0 ? edge - 1 : edge + 1;

      let ok = true;
      for (let t = 0; t < short && ok; t++) {
        const ax = dx !== 0 ? edge : p.x + t;
        const az = dx !== 0 ? p.z + t : edge;
        const rx = dx !== 0 ? rampAt : p.x + t;
        const rz = dx !== 0 ? p.z + t : rampAt;
        // Outside the course here...
        if (!inside(ax, az) || filled(az * sx + ax)) ok = false;
        // ...with the course below reaching exactly one stud past it.
        else if (grid.get(ax, y0 - 1, az) === EMPTY) ok = false;
        else if (
          inside(ax + dx, az + dz) &&
          grid.get(ax + dx, y0 - 1, az + dz) !== EMPTY
        ) {
          ok = false;
        }
        // Nothing may rest on the ramp.
        else if (aboveCourse && aboveCourse[rz * sx + rx] !== EMPTY) ok = false;
      }
      if (!ok) continue;

      const def = PART_BY_ID.get(`slope45-${short}x${long}`);
      if (!def) continue;
      if (!supplySupports(colorSupply[colorOf(p.color)] ?? 'common', def.supply)) continue;

      p.partId = def.id;
      p.code = def.code;
      p.facing = facing;
      break;
    }
  }
}

const SLOPE_DIRS: Array<[number, number, SlopeFacing]> = [
  [1, 0, '+x'],
  [-1, 0, '-x'],
  [0, 1, '+z'],
  [0, -1, '-z'],
];

/** How much of a region is left once its one-stud rim is taken off. */
function erodedArea(group: number[], candidate: Uint8Array, sx: number, sz: number): number {
  let n = 0;
  for (const i of group) {
    const x = i % sx;
    const z = (i / sx) | 0;
    if (x === 0 || z === 0 || x + 1 >= sx || z + 1 >= sz) continue;
    if (!candidate[i - 1] || !candidate[i + 1] || !candidate[i - sx] || !candidate[i + sx]) continue;
    n++;
  }
  return n;
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
