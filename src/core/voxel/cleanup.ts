/**
 * Making a sampled voxel blob into something that can actually be built.
 *
 * Three problems have to be solved before any bricks are chosen:
 *   - speckle: segmentation noise leaves single floating voxels
 *   - gravity: a component that never touches the build surface will fall off
 *   - cost:    a solid model wastes hundreds of parts on an invisible interior
 */

import { BRICK_MM, PLATE_MM, STUD_MM } from '../lego/units';
import { EMPTY, VoxelGrid } from './grid';

export interface CleanupStats {
  removedFragments: number;
  removedVoxels: number;
}

/** 6-connected labelling of the filled voxels. */
export function labelComponents(grid: VoxelGrid): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(grid.cells.length).fill(0);
  const sizes: number[] = [0];
  const stack: number[] = [];
  let next = 1;

  const { sx, sy, sz } = grid;
  for (let start = 0; start < grid.cells.length; start++) {
    if (grid.cells[start] === EMPTY || labels[start]) continue;
    labels[start] = next;
    stack.push(start);
    let count = 0;
    while (stack.length) {
      const p = stack.pop()!;
      count++;
      const x = p % sx;
      const z = ((p / sx) | 0) % sz;
      const y = (p / (sx * sz)) | 0;
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < sx - 1 ? p + 1 : -1,
        z > 0 ? p - sx : -1,
        z < sz - 1 ? p + sx : -1,
        y > 0 ? p - sx * sz : -1,
        y < sy - 1 ? p + sx * sz : -1,
      ];
      for (const q of neighbours) {
        if (q < 0) continue;
        if (grid.cells[q] === EMPTY || labels[q]) continue;
        labels[q] = next;
        stack.push(q);
      }
    }
    sizes.push(count);
    next++;
  }
  return { labels, sizes };
}

/** Delete components smaller than `minVoxels`. */
export function removeSmallComponents(grid: VoxelGrid, minVoxels: number): CleanupStats {
  const { labels, sizes } = labelComponents(grid);
  let removedFragments = 0;
  let removedVoxels = 0;
  const doomed = new Set<number>();
  for (let l = 1; l < sizes.length; l++) {
    if (sizes[l] < minVoxels) {
      doomed.add(l);
      removedFragments++;
      removedVoxels += sizes[l];
    }
  }
  // Never delete everything, however noisy the input.
  if (doomed.size === sizes.length - 1) {
    let biggest = 1;
    for (let l = 1; l < sizes.length; l++) if (sizes[l] > sizes[biggest]) biggest = l;
    doomed.delete(biggest);
    removedFragments--;
    removedVoxels -= sizes[biggest];
  }
  if (doomed.size > 0) {
    for (let i = 0; i < grid.cells.length; i++) {
      if (doomed.has(labels[i])) grid.cells[i] = EMPTY;
    }
  }
  return { removedFragments, removedVoxels };
}

/**
 * Give every component a path to the ground.
 *
 * For each component that does not reach y = 0, find the column where the drop
 * to solid material (or the build surface) is shortest, and fill that column.
 * Picking the shortest drop keeps the added strut as small — and as easy to
 * hide — as possible.
 */
export function groundComponents(grid: VoxelGrid, supportMask: Uint8Array): number {
  let added = 0;
  const { sx, sy, sz } = grid;

  for (let pass = 0; pass < 8; pass++) {
    const { labels, sizes } = labelComponents(grid);
    if (sizes.length <= 1) break;

    const touchesGround = new Uint8Array(sizes.length);
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const l = labels[grid.index(x, 0, z)];
        if (l > 0) touchesGround[l] = 1;
      }
    }

    let repaired = 0;
    for (let l = 1; l < sizes.length; l++) {
      if (touchesGround[l]) continue;

      // Best strut: shortest vertical gap from a voxel of this component down
      // to either the ground or a voxel of a different component.
      let bestGap = Infinity;
      let bestX = -1;
      let bestZ = -1;
      let bestY = -1;
      let bestColor = EMPTY;
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          for (let x = 0; x < sx; x++) {
            const i = grid.index(x, y, z);
            if (labels[i] !== l) continue;
            if (y > 0 && labels[grid.index(x, y - 1, z)] === l) continue; // not the underside
            let gap = 0;
            let yy = y - 1;
            while (yy >= 0 && grid.get(x, yy, z) === EMPTY) {
              gap++;
              yy--;
            }
            if (gap < bestGap) {
              bestGap = gap;
              bestX = x;
              bestZ = z;
              bestY = y;
              bestColor = grid.cells[i];
            }
          }
        }
      }

      if (bestX < 0 || bestGap === Infinity) continue;
      for (let y = bestY - 1; y >= bestY - bestGap; y--) {
        if (y < 0) break;
        const i = grid.index(bestX, y, bestZ);
        grid.cells[i] = bestColor;
        supportMask[i] = 1;
        added++;
      }
      repaired++;
    }
    if (repaired === 0) break;
  }
  return added;
}

/**
 * Carve the interior out, leaving a shell of a given thickness in millimetres.
 *
 * Millimetres, not voxels — this matters. A voxel step is 8mm sideways but only
 * 3.2mm vertically, so a shell of "two voxels" is 16mm through a wall and 6.4mm
 * through a floor or a ceiling. That is thinner than a single brick, and it is
 * how a hollowed model quietly falls apart into several disconnected shells.
 *
 * Distance to open space is therefore a shortest path with real step costs,
 * found with a bucket-queue Dijkstra that stops at the shell thickness.
 */
export function hollow(
  grid: VoxelGrid,
  shellMM = 16,
  keepBottomLayers = 3,
  courseAligned = true,
): number {
  const { sx, sy, sz } = grid;
  const n = grid.cells.length;

  // Tenths of a millimetre keeps the costs integral for the bucket queue.
  const STEP_XZ = Math.round(STUD_MM * 10);
  const STEP_Y = Math.round(PLATE_MM * 10);
  const limit = Math.round(shellMM * 10);

  // Int32Array cannot hold Infinity — it coerces to 0 — so use an explicit
  // sentinel for "not reached within the shell".
  const UNREACHED = 0x7fffffff;
  const dist = new Int32Array(n).fill(UNREACHED);
  const buckets: number[][] = Array.from({ length: limit + 1 }, () => []);

  const seed = (i: number, d: number) => {
    if (d > limit || d >= dist[i]) return;
    dist[i] = d;
    buckets[d].push(i);
  };

  // Seed every filled cell that touches open space — including the space
  // outside the grid, which is why border cells are seeded too.
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const i = grid.index(x, y, z);
        if (grid.cells[i] === EMPTY) continue;
        let best = UNREACHED;
        if (x === 0 || grid.get(x - 1, y, z) === EMPTY) best = Math.min(best, STEP_XZ);
        if (x === sx - 1 || grid.get(x + 1, y, z) === EMPTY) best = Math.min(best, STEP_XZ);
        if (z === 0 || grid.get(x, y, z - 1) === EMPTY) best = Math.min(best, STEP_XZ);
        if (z === sz - 1 || grid.get(x, y, z + 1) === EMPTY) best = Math.min(best, STEP_XZ);
        if (y === 0 || grid.get(x, y - 1, z) === EMPTY) best = Math.min(best, STEP_Y);
        if (y === sy - 1 || grid.get(x, y + 1, z) === EMPTY) best = Math.min(best, STEP_Y);
        if (best !== UNREACHED) seed(i, best);
      }
    }
  }

  for (let d = 0; d <= limit; d++) {
    const bucket = buckets[d];
    for (let bi = 0; bi < bucket.length; bi++) {
      const p = bucket[bi];
      if (dist[p] !== d) continue; // stale entry
      const x = p % sx;
      const z = ((p / sx) | 0) % sz;
      const y = (p / (sx * sz)) | 0;
      const relax = (q: number, cost: number) => {
        if (q < 0 || grid.cells[q] === EMPTY) return;
        const nd = d + cost;
        if (nd > limit || nd >= dist[q]) return;
        dist[q] = nd;
        buckets[nd].push(q);
      };
      relax(x > 0 ? p - 1 : -1, STEP_XZ);
      relax(x < sx - 1 ? p + 1 : -1, STEP_XZ);
      relax(z > 0 ? p - sx : -1, STEP_XZ);
      relax(z < sz - 1 ? p + sx : -1, STEP_XZ);
      relax(y > 0 ? p - sx * sz : -1, STEP_Y);
      relax(y < sy - 1 ? p + sx * sz : -1, STEP_Y);
    }
  }

  // Anything the search never reached is deeper than the shell.
  const removable = new Uint8Array(n);
  for (let y = keepBottomLayers; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const i = grid.index(x, y, z);
        if (grid.cells[i] !== EMPTY && dist[i] === UNREACHED) removable[i] = 1;
      }
    }
  }

  // Only carve away whole courses, so a course that becomes bricks stays a
  // uniform three plates tall rather than being cut into a ring of plates.
  if (courseAligned) {
    const courses = Math.floor(sy / 3);
    for (let c = 0; c < courses; c++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
          const a = grid.index(x, c * 3, z);
          const b = grid.index(x, c * 3 + 1, z);
          const cc = grid.index(x, c * 3 + 2, z);
          if (!(removable[a] && removable[b] && removable[cc])) {
            removable[a] = 0;
            removable[b] = 0;
            removable[cc] = 0;
          }
        }
      }
    }
  }

  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (removable[i]) {
      grid.cells[i] = EMPTY;
      removed++;
    }
  }
  return removed;
}

/**
 * Is the model thick enough that hollowing it leaves a shell rather than
 * eating the whole thing? Measured in millimetres in every axis.
 */
export function shouldHollow(grid: VoxelGrid, shellMM: number): boolean {
  return (
    grid.sx * STUD_MM >= shellMM * 2 + STUD_MM * 2 &&
    grid.sz * STUD_MM >= shellMM * 2 + STUD_MM * 2 &&
    grid.sy * PLATE_MM >= shellMM * 2 + BRICK_MM * 2
  );
}
