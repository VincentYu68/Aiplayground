/**
 * 3D reconstruction benchmark.
 *
 *   npx vite-node bench/run3d.ts [--views 1,2,4,8] [--studs 24]
 *
 * Renders known solids from N angles, runs the real pipeline, and scores the
 * *volume* it produces against the solid it came from. The pipeline's own
 * silhouette IoU is printed next to it on purpose: matching the outline of the
 * photo you were given is not evidence that the shape behind it is right, and
 * the gap between those two numbers is the thing worth looking at.
 */

import { generateModel } from '../src/core/build/pipeline';
import { DEFAULT_OPTIONS, type BuildResult } from '../src/types';
import { PLATE_MM, STUD_MM } from '../src/core/lego/units';
import { azimuthsFor, renderView, SOLIDS, type Solid } from './shapes3d';
import { mean, pct } from './metrics';

/** Canonical comparison volume, generous enough for the widest shape. */
const EXT = 1.15;
const NXZ = 76;
const NY = 64;

interface Recovered {
  occupied: (gx: number, gy: number, gz: number) => boolean;
  gridX: number;
  gridY: number;
  gridZ: number;
}

/** Rebuild a dense occupancy from the placed parts. */
function occupancyOf(result: BuildResult): Recovered {
  const { gridX, gridY, gridZ } = result;
  const cells = new Uint8Array(gridX * gridY * gridZ);
  for (const p of result.placements) {
    for (let dy = 0; dy < p.height; dy++) {
      for (let dz = 0; dz < p.d; dz++) {
        for (let dx = 0; dx < p.w; dx++) {
          const x = p.x + dx;
          const y = p.y + dy;
          const z = p.z + dz;
          if (x < 0 || y < 0 || z < 0 || x >= gridX || y >= gridY || z >= gridZ) continue;
          cells[(y * gridZ + z) * gridX + x] = 1;
        }
      }
    }
  }
  return {
    gridX,
    gridY,
    gridZ,
    occupied: (gx, gy, gz) =>
      gx >= 0 &&
      gy >= 0 &&
      gz >= 0 &&
      gx < gridX &&
      gy < gridY &&
      gz < gridZ &&
      cells[(gy * gridZ + gz) * gridX + gx] === 1,
  };
}

interface Extent {
  x: number;
  y: number;
  z: number;
}

interface Score3D {
  iou: number;
  /** Fraction of the true solid that is missing, and invented beyond it. */
  missed: number;
  invented: number;
  truthExtent: Extent;
  modelExtent: Extent;
}

/**
 * Score in a shared, physically-meaningful frame.
 *
 * Both volumes are expressed in units of the object's own height, which is the
 * one measurement every photo shares and the same unit the pipeline calibrates
 * with. They are aligned by their footprint centres and by the ground plane —
 * not rescaled to fit each other, because "the model came out too flat" has to
 * remain visible rather than being normalised away.
 */
function score3D(solid: Solid, result: BuildResult): Score3D {
  const recovered = occupancyOf(result);
  const unitsPerPlate = 1 / recovered.gridY;
  const unitsPerStud = unitsPerPlate * (STUD_MM / PLATE_MM);

  const cell = (2 * EXT) / NXZ;
  const cellY = 1 / NY;

  // Truth footprint centre, so an off-centre shape (a mug's handle) does not
  // score as a translation error.
  let tMinX = Infinity;
  let tMaxX = -Infinity;
  let tMinZ = Infinity;
  let tMaxZ = -Infinity;
  let tMinY = Infinity;
  let tMaxY = -Infinity;
  const truth = new Uint8Array(NXZ * NY * NXZ);
  for (let iy = 0; iy < NY; iy++) {
    const y = (iy + 0.5) * cellY;
    for (let iz = 0; iz < NXZ; iz++) {
      const z = -EXT + (iz + 0.5) * cell;
      for (let ix = 0; ix < NXZ; ix++) {
        const x = -EXT + (ix + 0.5) * cell;
        if (!solid.inside(x, y, z)) continue;
        truth[(iy * NXZ + iz) * NXZ + ix] = 1;
        if (x < tMinX) tMinX = x;
        if (x > tMaxX) tMaxX = x;
        if (z < tMinZ) tMinZ = z;
        if (z > tMaxZ) tMaxZ = z;
        if (y < tMinY) tMinY = y;
        if (y > tMaxY) tMaxY = y;
      }
    }
  }
  const centreX = (tMinX + tMaxX) / 2;
  const centreZ = (tMinZ + tMaxZ) / 2;

  let inter = 0;
  let union = 0;
  let truthCount = 0;
  let missed = 0;
  let invented = 0;
  let mMinX = Infinity;
  let mMaxX = -Infinity;
  let mMinZ = Infinity;
  let mMaxZ = -Infinity;
  let mMinY = Infinity;
  let mMaxY = -Infinity;

  for (let iy = 0; iy < NY; iy++) {
    const y = (iy + 0.5) * cellY;
    const gy = Math.floor(y / unitsPerPlate);
    for (let iz = 0; iz < NXZ; iz++) {
      const z = -EXT + (iz + 0.5) * cell;
      const gz = Math.floor((z - centreZ) / unitsPerStud + recovered.gridZ / 2);
      for (let ix = 0; ix < NXZ; ix++) {
        const x = -EXT + (ix + 0.5) * cell;
        const gx = Math.floor((x - centreX) / unitsPerStud + recovered.gridX / 2);

        const t = truth[(iy * NXZ + iz) * NXZ + ix] === 1;
        const m = recovered.occupied(gx, gy, gz);
        if (t && m) inter++;
        if (t || m) union++;
        if (t) truthCount++;
        if (t && !m) missed++;
        if (m && !t) invented++;
        if (m) {
          if (x < mMinX) mMinX = x;
          if (x > mMaxX) mMaxX = x;
          if (z < mMinZ) mMinZ = z;
          if (z > mMaxZ) mMaxZ = z;
          if (y < mMinY) mMinY = y;
          if (y > mMaxY) mMaxY = y;
        }
      }
    }
  }

  const span = (lo: number, hi: number) => (hi >= lo ? hi - lo : 0);
  return {
    iou: union === 0 ? 0 : inter / union,
    missed: truthCount === 0 ? 0 : missed / truthCount,
    invented: truthCount === 0 ? 0 : invented / truthCount,
    truthExtent: { x: span(tMinX, tMaxX), y: span(tMinY, tMaxY), z: span(tMinZ, tMaxZ) },
    modelExtent: { x: span(mMinX, mMaxX), y: span(mMinY, mMaxY), z: span(mMinZ, mMaxZ) },
  };
}

function parseList(flag: string, fallback: number[]): number[] {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1].split(',').map(Number);
}

function main(): void {
  const viewCounts = parseList('--views', [1, 2, 4, 8]);
  const studs = parseList('--studs', [24])[0];

  const options = {
    ...DEFAULT_OPTIONS,
    studsWide: studs,
    // Measure shape recovery, not the parts-saving pass: hollowing removes
    // interior that the truth solid has, and would read as a huge miss.
    hollow: false,
  };

  const rows: Array<{ solid: string; views: number; s: Score3D; silhouette: number }> = [];

  for (const solid of SOLIDS) {
    const rendered = new Map<number, ReturnType<typeof renderView>>();
    for (const n of viewCounts) {
      for (const a of azimuthsFor(n)) {
        if (!rendered.has(a)) rendered.set(a, renderView(solid, a));
      }
    }
    for (const n of viewCounts) {
      const views = azimuthsFor(n).map((a) => rendered.get(a)!);
      const result = generateModel(views, options);
      rows.push({
        solid: solid.name,
        views: n,
        s: score3D(solid, result),
        silhouette: result.fidelity.silhouetteIoU,
      });
    }
    process.stderr.write(`  ${solid.name} done\n`);
  }

  console.log('\n=== 3D IoU against the true solid ===');
  const header = 'solid'.padEnd(16) + viewCounts.map((n) => `${n}v`.padStart(9)).join('');
  console.log(header);
  for (const solid of SOLIDS) {
    const cells = viewCounts.map((n) => {
      const r = rows.find((q) => q.solid === solid.name && q.views === n)!;
      return pct(r.s.iou).padStart(9);
    });
    console.log(solid.name.padEnd(16) + cells.join(''));
  }
  console.log(
    'mean'.padEnd(16) +
      viewCounts
        .map((n) => pct(mean(rows.filter((r) => r.views === n).map((r) => r.s.iou))).padStart(9))
        .join(''),
  );

  console.log('\n=== what the pipeline reports instead (silhouette IoU, view 0) ===');
  console.log(
    'mean'.padEnd(16) +
      viewCounts
        .map((n) => pct(mean(rows.filter((r) => r.views === n).map((r) => r.silhouette))).padStart(9))
        .join(''),
  );

  console.log('\n=== depth extent, model / truth (1.00 is right; >1 too deep) ===');
  console.log(header);
  for (const solid of SOLIDS) {
    const cells = viewCounts.map((n) => {
      const r = rows.find((q) => q.solid === solid.name && q.views === n)!;
      const ratio = r.s.truthExtent.z > 0 ? r.s.modelExtent.z / r.s.truthExtent.z : 0;
      return ratio.toFixed(2).padStart(9);
    });
    console.log(solid.name.padEnd(16) + cells.join(''));
  }

  console.log('\n=== volume invented beyond the true solid, as a share of it ===');
  console.log(header);
  for (const solid of SOLIDS) {
    const cells = viewCounts.map((n) => {
      const r = rows.find((q) => q.solid === solid.name && q.views === n)!;
      return pct(r.s.invented).padStart(9);
    });
    console.log(solid.name.padEnd(16) + cells.join(''));
  }
}

main();
