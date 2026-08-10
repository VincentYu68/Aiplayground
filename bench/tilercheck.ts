/**
 * Scratch: is the tiler leaving parts on the table, or is the 1x1 share forced
 * by the geometry?
 *
 * Rebuilds the real grid the pipeline hands to the tiler, then tiles each layer
 * three ways and compares part counts:
 *   current      - the shipped seed-and-grow tiler
 *   largest      - repeatedly place the largest catalogue part that fits anywhere
 *   lowerBound   - area / largest usable part, which nothing can beat
 */
import { estimateDepth } from '../src/core/image/depth';
import { snapToCourses, voxelize } from '../src/core/voxel/voxelize';
import { groundComponents, hollow, removeSmallComponents, shouldHollow } from '../src/core/voxel/cleanup';
import { EMPTY } from '../src/core/voxel/grid';
import { tileGrid } from '../src/core/build/tiling';
import { BRICK_FOOTPRINT_LIST } from '../src/core/lego/catalog';
import { DEFAULT_OPTIONS } from '../src/types';
import { buildCorpus } from './scenes';

const FOOTPRINTS = [...BRICK_FOOTPRINT_LIST].sort((a, b) => b.area - a.area || a.w + a.d - (b.w + b.d));

/** Largest-part-first over the whole layer, ignoring bond and support. */
function tileLargestFirst(cells: Int16Array, sx: number, sz: number): number {
  const owner = new Int8Array(sx * sz);
  let parts = 0;
  for (const f of FOOTPRINTS) {
    for (let z = 0; z + f.d <= sz; z++) {
      for (let x = 0; x + f.w <= sx; x++) {
        const colour = cells[z * sx + x];
        if (colour === EMPTY || owner[z * sx + x]) continue;
        let fits = true;
        for (let dz = 0; dz < f.d && fits; dz++)
          for (let dx = 0; dx < f.w; dx++) {
            const i = (z + dz) * sx + x + dx;
            if (owner[i] || cells[i] !== colour) {
              fits = false;
              break;
            }
          }
        if (!fits) continue;
        for (let dz = 0; dz < f.d; dz++)
          for (let dx = 0; dx < f.w; dx++) owner[(z + dz) * sx + x + dx] = 1;
        parts++;
      }
    }
  }
  // Anything left is a 1x1.
  for (let i = 0; i < sx * sz; i++) if (cells[i] !== EMPTY && !owner[i]) parts++;
  return parts;
}

const seen = new Set<string>();
console.log('object    layerArea  current  largest  lowerBnd   current1x1  largest1x1');
for (const scene of buildCorpus()) {
  if (seen.has(scene.object)) continue;
  seen.add(scene.object);

  const options = { ...DEFAULT_OPTIONS, studsWide: 32 };
  const depth = estimateDepth(scene.rgba, scene.truth, scene.width, scene.height, {
    shadingInfluence: options.shadingInfluence,
  });
  const vr = voxelize(scene.rgba, scene.truth, scene.width, scene.height, depth, {
    studsWide: options.studsWide,
    depthScale: options.depthScale,
    solidMode: options.solidMode,
    backTreatment: options.backTreatment,
    maxColors: options.maxColors,
    wholeCourses: true,
    seed: options.seed,
  });
  let grid = vr.grid.trimmed().grid;
  grid = snapToCourses(grid);
  removeSmallComponents(grid, Math.max(4, Math.round(grid.count() * 0.0008)));
  if (options.hollow && shouldHollow(grid, 16)) hollow(grid, 16, 3, true);
  const supportMask = new Uint8Array(grid.cells.length);
  groundComponents(grid, supportMask);

  const shipped = tileGrid(grid, supportMask, vr.palette, {
    useBricks: true,
    restarts: 3,
    seed: options.seed,
  });
  const shippedOnes = shipped.placements.filter((p) => p.w === 1 && p.d === 1).length;

  // Compare on the same course layers the tiler works from.
  let area = 0;
  let largest = 0;
  let largestOnes = 0;
  let bound = 0;
  for (let c = 0; c * 3 < grid.sy; c++) {
    const y = c * 3;
    const layer = grid.layer(y);
    let n = 0;
    for (let i = 0; i < layer.length; i++) if (layer[i] !== EMPTY) n++;
    if (n === 0) continue;
    area += n;
    largest += tileLargestFirst(layer, grid.sx, grid.sz);
    bound += Math.ceil(n / 128);
    // count 1x1 leftovers under largest-first
    const owner = new Int8Array(grid.sx * grid.sz);
    for (const f of FOOTPRINTS) {
      for (let z = 0; z + f.d <= grid.sz; z++)
        for (let x = 0; x + f.w <= grid.sx; x++) {
          const colour = layer[z * grid.sx + x];
          if (colour === EMPTY || owner[z * grid.sx + x]) continue;
          let fits = true;
          for (let dz = 0; dz < f.d && fits; dz++)
            for (let dx = 0; dx < f.w; dx++) {
              const i = (z + dz) * grid.sx + x + dx;
              if (owner[i] || layer[i] !== colour) {
                fits = false;
                break;
              }
            }
          if (!fits) continue;
          for (let dz = 0; dz < f.d; dz++)
            for (let dx = 0; dx < f.w; dx++) owner[(z + dz) * grid.sx + x + dx] = 1;
          if (f.w === 1 && f.d === 1) largestOnes++;
        }
    }
    for (let i = 0; i < grid.sx * grid.sz; i++) if (layer[i] !== EMPTY && !owner[i]) largestOnes++;
  }

  console.log(
    `${scene.object.padEnd(9)} ${String(area).padStart(9)} ${String(shipped.placements.length).padStart(8)} ` +
      `${String(largest).padStart(8)} ${String(bound).padStart(9)} ${String(shippedOnes).padStart(12)} ${String(largestOnes).padStart(11)}`,
  );
}
