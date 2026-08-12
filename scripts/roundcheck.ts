/**
 * Does the roundness estimator actually separate a ball from a box?
 *
 *   npx vite-node scripts/roundcheck.ts
 *
 * `measuredRoundness` claims a depth map states outright whether a cross-section
 * is a convex cap or a flat face. That claim is checkable without the network
 * and without any photographs: synthesise the depth map each solid *would*
 * produce, and see what comes back. A statistic that cannot tell an analytic
 * sphere from an analytic slab is not going to do better on a photograph.
 *
 * The cases below are chosen for the ways this can go wrong rather than for the
 * ways it can go right — in particular the car, whose flat side carries strong
 * internal structure that must not be mistaken for curvature.
 */
import { measureRelief, depthFieldFromRelief } from '../src/core/image/depth';
import { planGrid, voxelize } from '../src/core/voxel/voxelize';
import { EMPTY } from '../src/core/voxel/grid';
import { DEFAULT_OPTIONS } from '../src/types';

const W = 256;
const H = 256;

interface Case {
  name: string;
  expect: string;
  /** Inside the silhouette? */
  inside: (x: number, y: number) => boolean;
  /** Inverse depth: larger is nearer. Only its shape matters. */
  relief: (x: number, y: number) => number;
}

const R = 90;
const cases: Case[] = [
  {
    name: 'sphere',
    expect: 'round (~1)',
    inside: (x, y) => Math.hypot(x - 128, y - 128) < R,
    // A sphere's visible surface: nearest at the pole, receding to the equator.
    relief: (x, y) => {
      const r = Math.min(R, Math.hypot(x - 128, y - 128));
      return Math.sqrt(Math.max(0, R * R - r * r));
    },
  },
  {
    name: 'cylinder on its side',
    expect: 'round (~1)',
    inside: (x, y) => x > 20 && x < 236 && Math.abs(y - 128) < 45,
    relief: (_x, y) => Math.sqrt(Math.max(0, 45 * 45 - (y - 128) * (y - 128))),
  },
  {
    name: 'box, face on',
    expect: 'flat (~0)',
    inside: (x, y) => Math.abs(x - 128) < 80 && Math.abs(y - 128) < 60,
    // A plane facing the camera is at one depth everywhere.
    relief: () => 100,
  },
  {
    name: 'car side-on (flat face, strong internal structure)',
    expect: 'flat (~0)',
    inside: (x, y) => {
      const body = Math.abs(x - 128) < 100 && y > 110 && y < 165;
      const cabin = Math.abs(x - 118) < 45 && y > 78 && y < 112;
      const wheels =
        Math.hypot(x - 70, y - 168) < 22 || Math.hypot(x - 186, y - 168) < 22;
      return body || cabin || wheels;
    },
    // Wheels proud of the doors, greenhouse set back — the structure that has to
    // survive, and that must not be read as curvature.
    relief: (x, y) => {
      const wheels = Math.hypot(x - 70, y - 168) < 22 || Math.hypot(x - 186, y - 168) < 22;
      if (wheels) return 120;
      if (y < 112) return 60;
      return 100;
    },
  },
  {
    name: 'flat plate with only noise',
    expect: 'flat (~0)',
    inside: (x, y) => Math.abs(x - 128) < 70 && Math.abs(y - 128) < 90,
    relief: (x, y) => 100 + Math.sin(x * 1.7) * 0.4 + Math.cos(y * 2.3) * 0.4,
  },
];

console.log('case                                             roundness   grid (w x plates x deep)');
for (const c of cases) {
  const rgba = new Uint8ClampedArray(W * H * 4).fill(180);
  const mask = new Uint8Array(W * H);
  const relief = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (c.inside(x, y)) {
        mask[i] = 1;
        relief[i] = c.relief(x, y);
      } else {
        // Background well behind the object, so the relief statistics have the
        // standout they need.
        relief[i] = 0;
      }
    }
  }

  const measured = measureRelief(relief, mask, W, H);
  const o = { ...DEFAULT_OPTIONS, studsWide: 32 };
  const po = {
    studsWide: o.studsWide,
    depthScale: o.depthScale,
    solidMode: o.solidMode,
    wholeCourses: o.resolution === 'bricks',
  };
  const plan = planGrid(mask, W, H, po, measured.reliefFraction)!;
  const halfDepthPx = (plan.gridZ / 2) * plan.pxPerStud;

  const field = depthFieldFromRelief(measured, mask, W, H, {
    roundness: o.roundness,
    halfDepthPx,
  });
  const { grid } = voxelize(rgba, mask, W, H, field, {
    ...po,
    backTreatment: o.backTreatment,
    maxColors: o.maxColors,
    seed: o.seed,
  });

  // Plan-view aspect: how square the footprint is where the object is widest.
  let widest = 0;
  let deepestAtWidest = 0;
  for (let z = 0; z < grid.sz; z++) {
    let run = 0;
    for (let x = 0; x < grid.sx; x++) {
      let f = false;
      for (let y = 0; y < grid.sy && !f; y++) f = grid.get(x, y, z) !== EMPTY;
      if (f) run++;
    }
    if (run > widest) widest = run;
  }
  for (let x = 0; x < grid.sx; x++) {
    let run = 0;
    for (let z = 0; z < grid.sz; z++) {
      let f = false;
      for (let y = 0; y < grid.sy && !f; y++) f = grid.get(x, y, z) !== EMPTY;
      if (f) run++;
    }
    if (run > deepestAtWidest) deepestAtWidest = run;
  }

  console.log(
    `${(c.name + ' [' + c.expect + ']').padEnd(52)}` +
      `${field.roundness.toFixed(2).padEnd(12)}` +
      `${grid.sx}x${grid.sy}x${grid.sz}`.padEnd(14) +
      `plan ${widest} wide x ${deepestAtWidest} deep`,
  );

  // The footprint, which is where a wrong closure shows up first.
  const rows: string[] = [];
  for (let z = grid.sz - 1; z >= 0; z--) {
    let line = '';
    for (let x = 0; x < grid.sx; x++) {
      let f = false;
      for (let y = 0; y < grid.sy && !f; y++) f = grid.get(x, y, z) !== EMPTY;
      line += f ? '#' : '.';
    }
    rows.push(line);
  }
  for (const r of rows) console.log('    ' + r);
  console.log();
}
