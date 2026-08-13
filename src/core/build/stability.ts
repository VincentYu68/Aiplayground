/**
 * Will it hold together, and will it stand up?
 *
 * Two different questions, and it is worth being precise about them, because
 * the intuitive voxel-level answer is wrong for LEGO:
 *
 *   - Two parts side by side in the same layer are NOT connected to each
 *     other. They are only joined if some part above or below bridges them.
 *     A "solid" voxel arm sticking out sideways is, in real bricks, a row of
 *     loose pieces lying next to each other.
 *   - A part is held by clutch power from either direction. A brick hanging
 *     under another brick is genuinely attached; it does not need to rest on
 *     anything to stay put.
 *
 * So connectivity is judged on the part graph (vertical overlap only), while
 * buildability is judged on whether each part has something underneath it when
 * its turn comes in the manual. Anything that fails the second test gets a
 * support column inserted underneath it.
 */

import { findPart, PART_BY_ID } from '../lego/catalog';
import { MAX_MISSING_FRACTION } from './fidelity';
import { COLOR_BY_LDRAW, deltaE2000 } from '../lego/colors';
import type { Placement, StabilityIssue, StabilityReport } from '../../types';

interface Dims {
  sx: number;
  sy: number;
  sz: number;
}

function buildOccupancy(placements: Placement[], dims: Dims): Uint8Array {
  const { sx, sy, sz } = dims;
  const occ = new Uint8Array(sx * sy * sz);
  for (const p of placements) {
    for (let y = p.y; y < p.y + p.height && y < sy; y++) {
      for (let dz = 0; dz < p.d; dz++) {
        for (let dx = 0; dx < p.w; dx++) {
          const x = p.x + dx;
          const z = p.z + dz;
          if (x < 0 || z < 0 || x >= sx || z >= sz) continue;
          occ[(y * sz + z) * sx + x] = 1;
        }
      }
    }
  }
  return occ;
}

/** Studs of `p` that overlap material in the layer at height `y`. */
function overlapAt(p: Placement, occ: Uint8Array, dims: Dims, y: number): number {
  const { sx, sy, sz } = dims;
  if (y < 0 || y >= sy) return 0;
  let n = 0;
  for (let dz = 0; dz < p.d; dz++) {
    for (let dx = 0; dx < p.w; dx++) {
      const x = p.x + dx;
      const z = p.z + dz;
      if (x >= sx || z >= sz) continue;
      if (occ[(y * sz + z) * sx + x]) n++;
    }
  }
  return n;
}

/** Studs of `p` that sit directly on top of material one layer below it. */
function studsBelow(p: Placement, occ: Uint8Array, dims: Dims): number {
  if (p.y === 0) return p.w * p.d;
  return overlapAt(p, occ, dims, p.y - 1);
}

/**
 * Studs of `p` gripped by the part(s) resting on it.
 *
 * A brick clutched from above is genuinely held — this is how the overhanging
 * underside of anything round gets built. It is not as convenient as resting on
 * something, but it is not a defect either, and treating it as one leads to a
 * model buried in support struts.
 */
function studsAbove(p: Placement, occ: Uint8Array, dims: Dims): number {
  return overlapAt(p, occ, dims, p.y + p.height);
}

class UnionFind {
  private parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a]];
      a = this.parent[a];
    }
    return a;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** Root label per placement; two parts share a label when they are joined. */
export function assemblyLabels(placements: Placement[], dims: Dims): Int32Array {
  const { sx, sy, sz } = dims;
  const uf = new UnionFind(placements.length);

  // For each interface height, which part owns each cell from above / below.
  const topAt: Array<Int32Array | undefined> = new Array(sy + 1);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const level = p.y + p.height;
    let arr = topAt[level];
    if (!arr) {
      arr = new Int32Array(sx * sz).fill(-1);
      topAt[level] = arr;
    }
    for (let dz = 0; dz < p.d; dz++) {
      for (let dx = 0; dx < p.w; dx++) {
        const x = p.x + dx;
        const z = p.z + dz;
        if (x < sx && z < sz) arr[z * sx + x] = i;
      }
    }
  }
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const arr = topAt[p.y];
    if (!arr) continue;
    for (let dz = 0; dz < p.d; dz++) {
      for (let dx = 0; dx < p.w; dx++) {
        const x = p.x + dx;
        const z = p.z + dz;
        if (x >= sx || z >= sz) continue;
        const other = arr[z * sx + x];
        if (other >= 0) uf.union(i, other);
      }
    }
  }

  const labels = new Int32Array(placements.length);
  for (let i = 0; i < placements.length; i++) labels[i] = uf.find(i);
  return labels;
}

/** Number of connected assemblies in the part graph. */
export function countAssemblies(placements: Placement[], dims: Dims): number {
  return new Set(assemblyLabels(placements, dims)).size;
}

/** How many assemblies there are, and how many parts the biggest one holds. */
function assemblyBreakdown(
  placements: Placement[],
  dims: Dims,
): { count: number; largest: number } {
  const sizes = new Map<number, number>();
  for (const label of assemblyLabels(placements, dims)) {
    sizes.set(label, (sizes.get(label) ?? 0) + 1);
  }
  let largest = 0;
  for (const n of sizes.values()) if (n > largest) largest = n;
  return { count: sizes.size, largest };
}

/**
 * Join assemblies that are lying against each other but not actually attached.
 *
 * A one-stud spur is voxel-connected to its neighbours — it touches them — but
 * in real bricks, two parts side by side in the same layer are not joined at
 * all. The fix is not to add anything: it is to re-cut the run they sit in so
 * that a single part straddles the join. A 1x4 next to a stranded 1x1 becomes a
 * 1x2 and a 1x3, the same five studs, now one connected piece.
 */
export function repairAssemblies(
  placements: Placement[],
  dims: Dims,
): { merged: number; removed: number; recoloured: number } {
  let merged = 0;
  let removed = 0;
  let recoloured = 0;

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const labels = assemblyLabels(placements, dims);
    const sizes = new Map<number, number>();
    for (const l of labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);
    if (sizes.size <= 1) break;

    let main = -1;
    let mainSize = -1;
    for (const [label, size] of sizes) {
      if (size > mainSize) {
        mainSize = size;
        main = label;
      }
    }

    const owner = ownerByLayer(placements, dims);

    // Two tiers, and a batch before a single. Re-cutting a run of one colour is
    // free, so that is tried everywhere first; only if nothing anywhere can be
    // joined for free do we allow a tie that repaints a few studs. Within each
    // tier every independent merge is applied at once — a model that has
    // fragmented into hundreds of pieces would never converge one at a time.
    const applied =
      applyBatch(placements, owner, labels, dims, sizes.size, main, false) ??
      applyBatch(placements, owner, labels, dims, sizes.size, main, true);

    if (applied) {
      merged += applied.count;
      recoloured += applied.repainted;
      continue;
    }

    // Nothing could be joined at all. Anything left is a stray spur; drop it
    // rather than ship a model with a piece that falls off.
    const doomed = new Set<number>();
    for (const [label, size] of sizes) {
      if (label !== main && size <= STRAY_ASSEMBLY_LIMIT) doomed.add(label);
    }
    if (doomed.size === 0) break;
    const keep = placements.filter((_, idx) => !doomed.has(labels[idx]));
    removed += placements.length - keep.length;
    placements.length = 0;
    placements.push(...keep);
  }

  return { merged, removed, recoloured };
}

/**
 * Apply as many independent merges as possible in one go, then check that the
 * model really did become less fragmented.
 *
 * Re-cutting a run can move a join instead of removing it — a 1x4 and a 1x1
 * with no 1x5 to replace them stays two pieces however you slice it — so the
 * whole batch is verified and, if it did not help, retried one merge at a time
 * so a single bad candidate cannot mask all the good ones.
 */
function applyBatch(
  placements: Placement[],
  owner: Int32Array[],
  labels: Int32Array,
  dims: Dims,
  assemblyCount: number,
  main: number,
  allowRecolour: boolean,
): { count: number; repainted: number } | null {
  const consumed = new Set<number>();
  const batch: Merge[] = [];
  for (let i = 0; i < placements.length; i++) {
    if (labels[i] === main || consumed.has(i)) continue;
    const merge = findMerge(placements, owner, labels, dims, i, allowRecolour);
    if (!merge) continue;
    const [ip, iq] = merge.replace;
    if (consumed.has(ip) || consumed.has(iq)) continue;
    consumed.add(ip);
    consumed.add(iq);
    batch.push(merge);
  }
  if (batch.length === 0) return null;

  const candidate = rebuild(placements, batch);
  if (new Set(assemblyLabels(candidate, dims)).size < assemblyCount) {
    placements.length = 0;
    placements.push(...candidate);
    return {
      count: batch.length,
      repainted: batch.reduce((n, m) => n + m.repainted, 0),
    };
  }

  // The batch as a whole did not help. Fall back to the cheapest single merge
  // that verifiably does.
  batch.sort((a, b) => a.cost - b.cost);
  for (const merge of batch.slice(0, MAX_MERGE_ATTEMPTS)) {
    const single = rebuild(placements, [merge]);
    if (new Set(assemblyLabels(single, dims)).size >= assemblyCount) continue;
    placements.length = 0;
    placements.push(...single);
    return { count: 1, repainted: merge.repainted };
  }
  return null;
}

/** A copy of `placements` with each merge's two parts swapped for its re-cut. */
function rebuild(placements: Placement[], merges: Merge[]): Placement[] {
  const dropped = new Set<number>();
  const added: Placement[] = [];
  for (const m of merges) {
    dropped.add(m.replace[0]);
    dropped.add(m.replace[1]);
    added.push(...m.parts);
  }
  const out = placements.filter((_, i) => !dropped.has(i));
  out.push(...added);
  return out;
}

/** Cap on single-merge retries when a whole batch fails to help. */
const MAX_MERGE_ATTEMPTS = 60;

/** Upper bound on repair rounds; each round can apply many merges at once. */
const MAX_REPAIR_PASSES = 60;

/** Most parts a single merge may leave behind, in place of the two it replaces. */
const MAX_MERGE_PARTS = 4;

/** Assemblies of at most this many parts may be discarded as strays. */
const STRAY_ASSEMBLY_LIMIT = 8;

/** For each height, which placement owns each cell of that layer. */
function ownerByLayer(placements: Placement[], dims: Dims): Int32Array[] {
  const { sx, sy, sz } = dims;
  const layers: Int32Array[] = [];
  for (let y = 0; y < sy; y++) layers.push(new Int32Array(sx * sz).fill(-1));
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    for (let y = p.y; y < p.y + p.height && y < sy; y++) {
      for (let dz = 0; dz < p.d; dz++) {
        for (let dx = 0; dx < p.w; dx++) {
          const x = p.x + dx;
          const z = p.z + dz;
          if (x < sx && z < sz) layers[y][z * sx + x] = i;
        }
      }
    }
  }
  return layers;
}

interface Merge {
  replace: [number, number];
  parts: Placement[];
  /** Studs whose colour had to change; 0 for a free re-cut. */
  repainted: number;
  /** Ranking key: perceptual damage done to the model. */
  cost: number;
}

/** Perceptual distance between two LDraw colours, for ranking tie candidates. */
function colorDistance(a: number, b: number): number {
  if (a === b) return 0;
  const ca = COLOR_BY_LDRAW.get(a);
  const cb = COLOR_BY_LDRAW.get(b);
  if (!ca || !cb) return 100;
  return deltaE2000(ca.lab, cb.lab);
}

/**
 * Look for a neighbour of placement `i` that belongs to a different assembly
 * and forms a rectangle with it, then re-cut that rectangle so the join moves.
 *
 * With `allowRecolour`, the two parts may differ in colour, and the union is
 * rebuilt in the colour of the larger part. That repaints a handful of studs,
 * which is the price of the model being one piece instead of two — but it is
 * only ever reached after every free re-cut has been tried, and candidates are
 * ranked so the least visible tie wins.
 */
function findMerge(
  placements: Placement[],
  owner: Int32Array[],
  labels: Int32Array,
  dims: Dims,
  i: number,
  allowRecolour: boolean,
): Merge | null {
  const { sx, sz } = dims;
  const p = placements[i];
  const seen = new Set<number>();
  let best: Merge | null = null;
  // A tile or a slope is chosen for what it looks like, and re-cutting works in
  // rectangles through `findPart`, which only ever answers with a brick or a
  // plate. Merging one therefore turned a finished top surface back into studs,
  // or a ramp back into a step, and dropped the `facing` that said which way it
  // pointed. Rare -- two tiles and a slope out of sixty-five on the corpus
  // chair -- but it is silent, and it undoes the part of the model that was
  // deliberately not a rectangle.
  if (!isRecuttable(p)) return null;

  const neighbours: Array<[number, number]> = [];
  for (let dz = 0; dz < p.d; dz++) {
    neighbours.push([p.x - 1, p.z + dz], [p.x + p.w, p.z + dz]);
  }
  for (let dx = 0; dx < p.w; dx++) {
    neighbours.push([p.x + dx, p.z - 1], [p.x + dx, p.z + p.d]);
  }

  for (const [nx, nz] of neighbours) {
    if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue;
    const j = owner[p.y][nz * sx + nx];
    if (j < 0 || j === i || seen.has(j)) continue;
    seen.add(j);

    const q = placements[j];
    if (!isRecuttable(q)) continue;
    if (labels[j] === labels[i]) continue;
    if (q.y !== p.y || q.height !== p.height) continue;

    const sameColor = q.color === p.color;
    if (!sameColor && !allowRecolour) continue;

    // The union takes the colour of the bigger part, so the smaller one is
    // what gets repainted.
    const color = p.w * p.d >= q.w * q.d ? p.color : q.color;
    const repainted = sameColor ? 0 : Math.min(p.w * p.d, q.w * q.d);
    const cost = repainted * colorDistance(p.color, q.color);
    if (best && cost >= best.cost) continue;

    const support = p.support && q.support;
    let parts: Placement[] | null = null;

    // Along X: same Z span, touching edges — the cheap case, one run re-cut.
    if (q.z === p.z && q.d === p.d && (q.x === p.x + p.w || p.x === q.x + q.w)) {
      const left = p.x < q.x ? p : q;
      const widths = coverRun(p.w + q.w, p.d, p.height, left.w);
      if (widths) {
        let x = left.x;
        parts = widths.map((w) => {
          const part = makePart(w, p.d, p.height, x, p.y, p.z, color, support);
          x += w;
          return part;
        });
      }
    }

    // Along Z: same X span, touching edges.
    if (!parts && q.x === p.x && q.w === p.w && (q.z === p.z + p.d || p.z === q.z + q.d)) {
      const front = p.z < q.z ? p : q;
      const depths = coverRun(p.d + q.d, p.w, p.height, front.d);
      if (depths) {
        let z = front.z;
        parts = depths.map((d) => {
          const part = makePart(p.w, d, p.height, p.x, p.y, z, color, support);
          z += d;
          return part;
        });
      }
    }

    // Neighbours that only partly overlap, which is most of them once a model
    // has fragmented. Both parts are split around the band where they do
    // overlap, and that band is re-cut as one run so a part straddles the join.
    //
    // Slicing is not free: the offcuts sit beside the band rather than on top
    // of it, so each one is a new piece that something else now has to hold.
    // A split that shatters two parts into a handful trades one break for
    // several, so anything but a tidy re-cut is refused.
    if (!parts) {
      const general = mergeOverlapping(p, q, color, support);
      parts = general && general.length <= MAX_MERGE_PARTS ? general : null;
    }

    if (parts) best = { replace: [i, j], parts, repainted, cost: cost + parts.length * 0.01 };
  }
  return best;
}

/** Sizes worth trying, largest first; every catalogue footprint uses one. */
const CANDIDATE_SIZES = [16, 12, 10, 8, 6, 4, 3, 2, 1];

function validWidths(depth: number, height: Placement['height']): number[] {
  return CANDIDATE_SIZES.filter((w) => findPart(w, depth, height) !== undefined);
}

/** Split `total` into catalogue-valid pieces, largest first. */
function splitInto(total: number, isValid: (n: number) => boolean): number[] | null {
  const out: number[] = [];
  let left = total;
  while (left > 0) {
    const pick = CANDIDATE_SIZES.find((n) => n <= left && isValid(n));
    if (pick === undefined) return null;
    out.push(pick);
    left -= pick;
  }
  return out;
}

/** Tile a plain rectangle with catalogue parts of one colour. */
function coverRect(
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  height: Placement['height'],
  color: number,
  support: boolean | undefined,
): Placement[] | null {
  if (w <= 0 || d <= 0) return [];
  const depths = splitInto(d, (n) => validWidths(n, height).length > 0);
  if (!depths) return null;

  const out: Placement[] = [];
  let zz = z;
  for (const dd of depths) {
    const widths = splitInto(w, (n) => findPart(n, dd, height) !== undefined);
    if (!widths) return null;
    let xx = x;
    for (const ww of widths) {
      out.push(makePart(ww, dd, height, xx, y, zz, color, support));
      xx += ww;
    }
    zz += dd;
  }
  return out;
}

/**
 * Re-cut two partly overlapping neighbours so that one part crosses the join.
 *
 * Each part is sliced into the band where the two overlap plus whatever sticks
 * out beyond it; the overhanging slices keep their own colour, and the shared
 * band is laid as a single run across both. That covers exactly the same studs
 * as before, and the run across the band is what actually ties the two
 * assemblies into one.
 */
function mergeOverlapping(
  p: Placement,
  q: Placement,
  color: number,
  support: boolean | undefined,
): Placement[] | null {
  const alongX = q.x === p.x + p.w || p.x === q.x + q.w;
  const alongZ = q.z === p.z + p.d || p.z === q.z + q.d;
  if (alongX === alongZ) return null; // must touch on exactly one axis

  // Work in (major, minor) so the two axes share one code path.
  const major = (r: Placement) => (alongX ? r.x : r.z);
  const majorSize = (r: Placement) => (alongX ? r.w : r.d);
  const minor = (r: Placement) => (alongX ? r.z : r.x);
  const minorSize = (r: Placement) => (alongX ? r.d : r.w);

  const lo = Math.max(minor(p), minor(q));
  const hi = Math.min(minor(p) + minorSize(p), minor(q) + minorSize(q)) - 1;
  const band = hi - lo + 1;
  if (band < 1) return null;

  const out: Placement[] = [];
  const emit = (
    majorStart: number,
    minorStart: number,
    majorLen: number,
    minorLen: number,
    c: number,
    sup: boolean | undefined,
  ) => {
    const rect = alongX
      ? coverRect(majorStart, p.y, minorStart, majorLen, minorLen, p.height, c, sup)
      : coverRect(minorStart, p.y, majorStart, minorLen, majorLen, p.height, c, sup);
    if (!rect) return false;
    out.push(...rect);
    return true;
  };

  // The slices of each part that stick out past the shared band.
  for (const r of [p, q]) {
    const before = lo - minor(r);
    const after = minor(r) + minorSize(r) - 1 - hi;
    if (before > 0 && !emit(major(r), minor(r), majorSize(r), before, r.color, r.support)) return null;
    if (after > 0 && !emit(major(r), hi + 1, majorSize(r), after, r.color, r.support)) return null;
  }

  // The shared band, laid as one run so a part crosses the join.
  const first = major(p) < major(q) ? p : q;
  const total = majorSize(p) + majorSize(q);
  const joinAt = majorSize(first);
  const depths = splitInto(band, (n) => validWidths(n, p.height).length > 0);
  if (!depths) return null;

  let spanned = false;
  let minorAt = lo;
  for (const dd of depths) {
    const runs =
      coverRun(total, dd, p.height, joinAt) ??
      splitInto(total, (n) => findPart(n, dd, p.height) !== undefined);
    if (!runs) return null;
    let majorAt = major(first);
    for (const len of runs) {
      const start = majorAt - major(first);
      if (start < joinAt && start + len > joinAt) spanned = true;
      const part = alongX
        ? makePart(len, dd, p.height, majorAt, p.y, minorAt, color, support)
        : makePart(dd, len, p.height, minorAt, p.y, majorAt, color, support);
      out.push(part);
      majorAt += len;
    }
    minorAt += dd;
  }

  return spanned ? out : null;
}

/**
 * Can this part be dissolved back into rectangles?
 *
 * Only the plain ones. Everything the re-cut produces comes from `findPart`,
 * which knows footprints and heights and nothing about shape.
 */
function isRecuttable(p: Placement): boolean {
  const def = PART_BY_ID.get(p.partId);
  return def === undefined || def.shape === 'brick' || def.shape === 'plate';
}

function makePart(
  w: number,
  d: number,
  height: Placement['height'],
  x: number,
  y: number,
  z: number,
  color: number,
  support: boolean | undefined,
): Placement {
  const def = findPart(w, d, height)!;
  return {
    partId: def.id,
    code: def.code,
    w,
    d,
    height,
    x,
    y,
    z,
    color,
    ...(support ? { support: true } : {}),
  };
}

/**
 * Cover a run of `total` studs with catalogue parts, avoiding a join at
 * `avoidSplit` — that is the join we are trying to get rid of.
 */
function coverRun(
  total: number,
  other: number,
  height: Placement['height'],
  avoidSplit: number,
): number[] | null {
  if (findPart(total, other, height)) return [total];
  for (let s = 1; s < total; s++) {
    if (s === avoidSplit) continue;
    if (findPart(s, other, height) && findPart(total - s, other, height)) return [s, total - s];
  }
  return null;
}

/**
 * Prop up the parts that nothing holds — no studs underneath and nothing
 * clutching them from above. Those would simply fall off, so they get a 1x1
 * column down to the nearest solid material, in the colour of the part they
 * carry so the strut disappears into the model.
 *
 * Parts that are merely overhanging but clamped from above are left alone.
 */
export function addSupports(placements: Placement[], dims: Dims): number {
  const brick1x1 = findPart(1, 1, 3)!;
  const plate1x1 = findPart(1, 1, 1)!;
  let added = 0;

  for (let pass = 0; pass < 6; pass++) {
    const occ = buildOccupancy(placements, dims);
    const needy = placements.filter(
      (p) => p.y > 0 && studsBelow(p, occ, dims) === 0 && studsAbove(p, occ, dims) === 0,
    );
    if (needy.length === 0) break;

    const newParts: Placement[] = [];
    for (const p of needy) {
      // Shortest drop anywhere under this part's footprint.
      let bestGap = Infinity;
      let bestX = p.x;
      let bestZ = p.z;
      for (let dz = 0; dz < p.d; dz++) {
        for (let dx = 0; dx < p.w; dx++) {
          const x = p.x + dx;
          const z = p.z + dz;
          if (x >= dims.sx || z >= dims.sz) continue;
          let gap = 0;
          let y = p.y - 1;
          while (y >= 0 && !occ[(y * dims.sz + z) * dims.sx + x]) {
            gap++;
            y--;
          }
          if (gap < bestGap) {
            bestGap = gap;
            bestX = x;
            bestZ = z;
          }
        }
      }
      if (!Number.isFinite(bestGap) || bestGap === 0) continue;

      let y = p.y - bestGap;
      let remaining = bestGap;
      while (remaining > 0) {
        const useBrick = remaining >= 3;
        const part = useBrick ? brick1x1 : plate1x1;
        const height = useBrick ? 3 : 1;
        newParts.push({
          partId: part.id,
          code: part.code,
          w: 1,
          d: 1,
          height,
          x: bestX,
          y,
          z: bestZ,
          color: p.color,
          support: true,
        });
        y += height;
        remaining -= height;
        added++;
      }
    }
    if (newParts.length === 0) break;
    placements.push(...newParts);
  }

  return added;
}

export interface AnalyseInput {
  placements: Placement[];
  dims: Dims;
  seamAlignment: number;
  removedFragments: number;
  supportsAdded: number;
  tiesRecoloured: number;
  /**
   * Share of the intended volume that never became parts.
   *
   * Without it the score is about whatever survived rather than about the
   * object: a frame that tiled down to a single brick, a pencil 1.65m tall and
   * a slab cropped by the frame edge all scored 100/100 with no issues, because
   * one brick has nothing floating, nothing weakly joined and a perfect bond.
   * Every structural term here is a ratio over the parts that exist, so a model
   * with almost no parts left cannot fail any of them.
   */
  missingFraction?: number;
}

export function analyseStability(input: AnalyseInput): StabilityReport {
  const { placements, dims, seamAlignment } = input;
  const occ = buildOccupancy(placements, dims);
  const issues: StabilityIssue[] = [];

  let floating = 0;
  let cantilevered = 0;
  let weak = 0;
  let overhang = 0;
  let studSum = 0;
  let aboveGround = 0;
  let ground = 0;

  for (const p of placements) {
    delete p.needsHold;
    if (p.y === 0) {
      ground++;
      continue;
    }
    aboveGround++;
    const n = studsBelow(p, occ, dims);
    studSum += n;
    const area = p.w * p.d;
    if (n === 0) {
      const clamped = studsAbove(p, occ, dims);
      if (clamped === 0) {
        floating++;
        if (issues.length < 40) {
          issues.push({
            kind: 'floating',
            message: `${p.partId} at (${p.x}, ${p.y}, ${p.z}) has nothing holding it`,
            at: { x: p.x, y: p.y, z: p.z },
          });
        }
      } else {
        cantilevered++;
        p.needsHold = true;
      }
    } else if (n === 1 && area >= 4) {
      weak++;
      if (issues.length < 40) {
        issues.push({
          kind: 'weak-connection',
          message: `${p.partId} at (${p.x}, ${p.y}, ${p.z}) is held by a single stud`,
          at: { x: p.x, y: p.y, z: p.z },
        });
      }
    } else if (n < area * 0.25) {
      overhang++;
      if (issues.length < 40) {
        issues.push({
          kind: 'overhang',
          message: `${p.partId} at (${p.x}, ${p.y}, ${p.z}) overhangs by ${Math.round(
            (1 - n / area) * 100,
          )}%`,
          at: { x: p.x, y: p.y, z: p.z },
        });
      }
    }
  }

  const breakdown = assemblyBreakdown(placements, dims);
  const assemblies = breakdown.count;
  const detachedFraction =
    placements.length > 0 ? (placements.length - breakdown.largest) / placements.length : 0;
  if (assemblies > 1) {
    issues.push({
      kind: 'floating',
      message: `Model comes apart into ${assemblies} sections holding ${Math.round(
        detachedFraction * 100,
      )}% of the parts — mount it on a baseplate to hold them together`,
    });
  }
  if (seamAlignment > 0.45) {
    issues.push({
      kind: 'aligned-seams',
      message: `${Math.round(seamAlignment * 100)}% of joints line up with the course below, which weakens the bond`,
    });
  }
  if (cantilevered > 0) {
    issues.push({
      kind: 'held-above',
      message: `${cantilevered} part${
        cantilevered === 1 ? '' : 's'
      } overhang and are locked in by the course above — hold them in place until the next step`,
    });
  }

  const denom = Math.max(1, aboveGround);
  const floatingFraction = floating / denom;
  const weakFraction = weak / denom;
  const overhangFraction = overhang / denom;
  const cantileverFraction = cantilevered / denom;

  // Perfect stagger is unattainable on an organic shape: with many small parts,
  // some joints coincide with the layer below by chance alone. So the bond
  // penalty measures the *excess* over a normal running bond — nothing below
  // 25% aligned, full penalty at 70%, which is where a model starts splitting
  // along visible vertical cracks.
  const bondExcess = Math.max(0, Math.min(1, (seamAlignment - 0.25) / 0.45));

  let score = 100;
  // What was thrown away counts against the model, and hard. Losing a fifth of
  // the object is not a blemish on an otherwise sound build; it is a different
  // build, and the fidelity report already refuses to quote a silhouette score
  // past 2%.
  const missing = Math.max(0, Math.min(1, input.missingFraction ?? 0));
  score -= 90 * missing;
  if (missing > MAX_MISSING_FRACTION) {
    issues.push({
      kind: 'floating',
      message: `${Math.round(missing * 100)}% of the shape could not be built out of parts that hold together, so what is scored here is not the model that was measured.`,
    });
  }
  score -= 45 * floatingFraction;
  score -= 25 * bondExcess;
  score -= 20 * weakFraction;
  score -= 12 * overhangFraction;
  // Cantilevers cost the build its convenience, not its integrity.
  score -= 8 * cantileverFraction;
  // Coming apart in sections is the one thing a model must not do, so this is
  // scored on how much of the model is detached rather than on a flat count.
  if (assemblies > 1) score -= 12 + 45 * detachedFraction;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    grounded: ground > 0 && assemblies === 1,
    supportsAdded: input.supportsAdded,
    removedFragments: input.removedFragments,
    weakConnections: weak,
    cantilevered,
    assemblies,
    tiesRecoloured: input.tiesRecoloured,
    seamAlignment,
    averageStudsBelow: aboveGround ? studSum / aboveGround : 0,
    issues,
  };
}
