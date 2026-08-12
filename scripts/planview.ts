/**
 * What shape is the model in plan?
 *
 *   npx vite-node scripts/planview.ts bench/out/photos/car.png
 *
 * The browser round-trip takes minutes and the thing that was wrong for two
 * rounds — a side-on car coming out as a disc from above — is pure geometry that
 * needs no depth model and no renderer to see. This runs the real `planGrid`,
 * `depthFieldFromRelief` and `voxelize` over a photo's alpha mask and prints the
 * top-down and side occupancy as text.
 *
 * The relief handed in is deliberately *flat*, so what is printed is the closure
 * alone. That is the point: the closure decides the plan-view outline, and it
 * has to be right before anything the depth map says can matter.
 */
import { readFileSync } from 'node:fs';
import { decodePng } from '../bench/png';
import { measureRelief, depthFieldFromRelief } from '../src/core/image/depth';
import { planGrid, voxelize } from '../src/core/voxel/voxelize';
import { EMPTY } from '../src/core/voxel/grid';
import { DEFAULT_OPTIONS } from '../src/types';

const file = process.argv[2] ?? 'bench/out/photos/car.png';
const maskFile = process.argv[3];
const studs = Number(process.env.STUDS ?? 32);
const roundness = Number(process.env.ROUNDNESS ?? DEFAULT_OPTIONS.roundness);
const depthScale = Number(process.env.DEPTH_SCALE ?? DEFAULT_OPTIONS.depthScale);

const img = decodePng(readFileSync(file));
const { width, height } = img;
const mask = new Uint8Array(width * height);
if (maskFile) {
  const m = decodePng(readFileSync(maskFile));
  for (let i = 0; i < mask.length; i++) mask[i] = m.rgba[i * 4] > 127 ? 1 : 0;
} else {
  // The bench photos are drawn on an opaque sweep, so fall back to "not the
  // background colour" when there is no alpha to read.
  let transparent = 0;
  for (let i = 0; i < mask.length; i++) if (img.rgba[i * 4 + 3] < 128) transparent++;
  if (transparent > mask.length * 0.02) {
    for (let i = 0; i < mask.length; i++) mask[i] = img.rgba[i * 4 + 3] > 127 ? 1 : 0;
  } else {
    const [br, bg, bb] = [img.rgba[0], img.rgba[1], img.rgba[2]];
    for (let i = 0; i < mask.length; i++) {
      const d =
        Math.abs(img.rgba[i * 4] - br) +
        Math.abs(img.rgba[i * 4 + 1] - bg) +
        Math.abs(img.rgba[i * 4 + 2] - bb);
      mask[i] = d > 40 ? 1 : 0;
    }
  }
}

const flat = new Float32Array(width * height);
const measured = measureRelief(flat, mask, width, height);
const options = { ...DEFAULT_OPTIONS, studsWide: studs, depthScale, roundness };
const planOptions = {
  studsWide: options.studsWide,
  depthScale: options.depthScale,
  solidMode: options.solidMode,
  wholeCourses: options.resolution === 'bricks',
};
const plan = planGrid(mask, width, height, planOptions, measured.reliefFraction);
if (!plan) throw new Error('no object in the mask');

const depth = depthFieldFromRelief(measured, mask, width, height, {
  roundness: options.roundness,
  halfDepthPx: (plan.gridZ / 2) * plan.pxPerStud,
});
const { grid } = voxelize(img.rgba, mask, width, height, depth, {
  studsWide: options.studsWide,
  depthScale: options.depthScale,
  solidMode: options.solidMode,
  backTreatment: options.backTreatment,
  maxColors: options.maxColors,
  wholeCourses: options.resolution === 'bricks',
  seed: options.seed,
});

console.log(
  `${file}  silhouette ${plan.box.width}x${plan.box.height}px  ` +
    `grid ${grid.sx} wide x ${grid.sy} plates x ${grid.sz} deep  ` +
    `(short axis ${(Math.min(plan.gridX, plan.gridY / 2.5)).toFixed(1)} studs, ` +
    `halfDepth ${((plan.gridZ / 2) * plan.pxPerStud).toFixed(1)}px)`,
);

/** Occupancy collapsed along one axis, as text. */
function project(axis: 'y' | 'x'): string[] {
  const rows: string[] = [];
  const [du, dv] = axis === 'y' ? [grid.sz, grid.sx] : [grid.sy, grid.sz];
  for (let v = du - 1; v >= 0; v--) {
    let line = '';
    for (let u = 0; u < dv; u++) {
      let filled = false;
      if (axis === 'y') {
        for (let y = 0; y < grid.sy && !filled; y++) filled = grid.get(u, y, v) !== EMPTY;
      } else {
        for (let x = 0; x < grid.sx && !filled; x++) filled = grid.get(x, v, u) !== EMPTY;
      }
      line += filled ? '#' : '.';
    }
    rows.push(line);
  }
  return rows;
}

console.log('\nTOP (x across, z down — should be the object\'s footprint):');
for (const r of project('y')) console.log('  ' + r);
console.log('\nSIDE (z across, y up — the cross-section through the deepest part):');
for (const r of project('x')) console.log('  ' + r);
