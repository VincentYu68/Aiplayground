import { describe, expect, it } from 'vitest';
import { clampBox } from '../src/core/image/sam';
import { hintsToPoints, proposeBox } from '../src/core/image/propose';
import { buildCorpus } from '../bench/scenes';
import { score } from '../bench/metrics';
import { azimuthsFor, renderView, SOLIDS } from '../bench/shapes3d';
import { ARCHETYPE_BY_CLASS, CLASS_NAMES } from '../src/core/recognise/imagenet';
import { shapePriorFor } from '../src/core/recognise/shapePrior';
import { generateModel } from '../src/core/build/pipeline';
import { EMPTY, VoxelGrid } from '../src/core/voxel/grid';
import { snapToCourses } from '../src/core/voxel/voxelize';
import { selectPalette } from '../src/core/voxel/quantize';
import { latheProfile } from '../src/core/image/depth';
import { hollow, labelComponents, shouldHollow } from '../src/core/voxel/cleanup';
import { tileGrid } from '../src/core/build/tiling';
import {
  addSupports,
  analyseStability,
  countAssemblies,
  repairAssemblies,
} from '../src/core/build/stability';
import { buildSteps, orderPlacements } from '../src/core/build/steps';
import { assertObjectFound, measureFidelity, MAX_MISSING_FRACTION } from '../src/core/build/fidelity';
import { findPart, ALL_PARTS } from '../src/core/lego/catalog';
import {
  COLOR_BY_LDRAW,
  deltaE2000,
  nearestColorIndex,
  PALETTE,
  rgbToLab,
} from '../src/core/lego/colors';
import { platesForAspect } from '../src/core/lego/units';
import { toLdraw } from '../src/core/export/ldraw';
import { toPrintableManual } from '../src/core/export/manual';
import { buildPartsList, partsListToBricklinkXml, partsListToCsv } from '../src/core/export/bom';
import { distanceTransform, fillHoles, keepLargestComponents } from '../src/core/image/raster';
import { segment } from '../src/core/image/segment';
import { MaxFlow } from '../src/core/image/maxflow';
import { carveVisualHull } from '../src/core/multiview/visualHull';
import { DEFAULT_OPTIONS, type BuildOptions, type Placement } from '../src/types';

/** A synthetic photo: a coloured disc on a flat background. */
function makeTestImage(width: number, height: number) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = Math.hypot(x - cx, y - cy) <= radius;
      if (inside) {
        // Shaded red sphere.
        const shade = 1 - Math.hypot(x - cx * 0.8, y - cy * 0.8) / (radius * 2.2);
        rgba[i] = 200 * shade + 40;
        rgba[i + 1] = 30 * shade;
        rgba[i + 2] = 26 * shade;
      } else {
        rgba[i] = 235;
        rgba[i + 1] = 238;
        rgba[i + 2] = 240;
      }
      rgba[i + 3] = 255;
    }
  }
  return { rgba, width, height };
}

function discMask(width: number, height: number, scale = 0.35) {
  const mask = new Uint8Array(width * height);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * scale;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      mask[y * width + x] = Math.hypot(x - cx, y - cy) <= radius ? 1 : 0;
    }
  }
  return mask;
}

describe('LEGO units', () => {
  it('keeps proportions when converting image aspect to plate layers', () => {
    // A square image at 20 studs wide is 20 * 8mm = 160mm, which is 50 plates.
    expect(platesForAspect(20, 100, 100)).toBe(50);
    // Twice as tall as wide.
    expect(platesForAspect(20, 100, 200)).toBe(100);
  });
});

describe('colour matching', () => {
  it('snaps to an exact palette entry with zero error', () => {
    const white = PALETTE.find((c) => c.name === 'White')!;
    const { index, deltaE } = nearestColorIndex(rgbToLab(255, 255, 255));
    expect(PALETTE[index].ldraw).toBe(white.ldraw);
    expect(deltaE).toBeLessThan(0.01);
  });

  it('deltaE2000 is symmetric and zero for identical colours', () => {
    const a = rgbToLab(12, 200, 90);
    const b = rgbToLab(180, 40, 70);
    expect(deltaE2000(a, a)).toBeCloseTo(0, 6);
    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 6);
  });

  it('prefers a perceptually near colour over a numerically near one', () => {
    // Mid grey should land on a grey, never on a saturated hue.
    const { index } = nearestColorIndex(rgbToLab(150, 152, 150));
    expect(PALETTE[index].name).toMatch(/Gray/);
  });
});

describe('parts catalogue', () => {
  it('resolves both orientations of an asymmetric part to one element', () => {
    const a = findPart(2, 4, 3);
    const b = findPart(4, 2, 3);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a!.code).toBe('3001');
  });

  it('has a 1x1 in both heights so any voxel can be covered', () => {
    expect(findPart(1, 1, 3)).toBeDefined();
    expect(findPart(1, 1, 1)).toBeDefined();
  });

  it('uses unique element codes per height class', () => {
    const seen = new Set<string>();
    for (const part of ALL_PARTS) {
      const key = `${part.height}:${part.code}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('raster helpers', () => {
  it('measures distance from the edge of a shape', () => {
    const w = 21;
    const h = 21;
    const mask = discMask(w, h, 0.45);
    const dist = distanceTransform(mask, w, h);
    expect(dist[10 * w + 10]).toBeGreaterThan(dist[10 * w + 2]);
    expect(dist[0]).toBe(0);
  });

  it('fills enclosed holes but leaves the outside alone', () => {
    const w = 9;
    const h = 9;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) mask[y * w + x] = 1;
    mask[4 * w + 4] = 0; // punch a hole
    const filled = fillHoles(mask, w, h);
    expect(filled[4 * w + 4]).toBe(1);
    expect(filled[0]).toBe(0);
  });

  it('drops small components', () => {
    const w = 12;
    const h = 12;
    const mask = new Uint8Array(w * h);
    for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) mask[y * w + x] = 1;
    mask[10 * w + 10] = 1; // speck
    const kept = keepLargestComponents(mask, w, h, 0.2);
    expect(kept[10 * w + 10]).toBe(0);
    expect(kept[3 * w + 3]).toBe(1);
  });
});

describe('max-flow', () => {
  it('finds the min cut of a small graph with a known answer', () => {
    // Two pixels. Pixel 0 wants foreground (cheap to keep), pixel 1 wants
    // background, and the link between them is weak enough to break.
    const flow = new MaxFlow(2, 1);
    flow.addEdge(0, 1, 1, 1);
    flow.addTerminals(0, 10, 1);
    flow.addTerminals(1, 1, 10);
    const value = flow.compute();
    // Separating them cuts s->1, 0->t and the link between them: 1 + 1 + 1.
    // Keeping them together would cost 11 either way.
    expect(value).toBe(3);
    const side = flow.sourceSide();
    expect(side[0]).toBe(1);
    expect(side[1]).toBe(0);
  });

  it('keeps neighbours together when the link between them is strong', () => {
    const flow = new MaxFlow(2, 1);
    flow.addEdge(0, 1, 100, 100);
    flow.addTerminals(0, 10, 1);
    flow.addTerminals(1, 1, 10);
    flow.compute();
    const side = flow.sourceSide();
    // Breaking the pair would cost more than mislabelling one of them.
    expect(side[0]).toBe(side[1]);
  });
});

describe('segmentation', () => {
  it('finds a solid object on a plain background', () => {
    const { rgba, width, height } = makeTestImage(96, 96);
    const { mask } = segment(rgba, width, height, { threshold: 0.5 });
    const truth = discMask(width, height);

    let intersection = 0;
    let union = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] || truth[i]) union++;
      if (mask[i] && truth[i]) intersection++;
    }
    expect(intersection / union).toBeGreaterThan(0.85);
  });

  it('separates an object whose colour barely differs from the background', () => {
    // The case a per-pixel threshold cannot do: object and wall only a few
    // levels apart, with noise on both. A global cut holds the boundary
    // because breaking it costs boundary length.
    const W = 220;
    const H = 260;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const truth = new Uint8Array(W * H);
    const noise = (s: number) => ((Math.sin(s * 127.1) * 43758.5453) % 1) * 14;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = Math.hypot((x - W / 2) / (W * 0.26), (y - H / 2) / (H * 0.32)) <= 1;
        truth[y * W + x] = inside ? 1 : 0;
        const n = noise(x * 3.1 + y * 7.7);
        const base = inside ? 196 : 224;
        const i = (y * W + x) * 4;
        rgba[i] = base + n;
        rgba[i + 1] = base + 3 + n;
        rgba[i + 2] = base + 7 + n;
        rgba[i + 3] = 255;
      }
    }

    const { mask } = segment(rgba, W, H, { threshold: 0.5 });
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] || truth[i]) union++;
      if (mask[i] && truth[i]) intersection++;
    }
    expect(intersection / union).toBeGreaterThan(0.9);
  });

  it('does not collapse to an empty mask at any image size', () => {
    // The boundary term scales with the object's perimeter and the fit term
    // with its area, so there is an image size at which "everything is
    // background" becomes the cheaper labelling. It used to return one single
    // foreground pixel at 300x340 and nothing at all after cleanup.
    const noise = (s: number) => ((Math.sin(s * 127.1) * 43758.5453) % 1) * 14;
    for (const [W, H] of [
      [220, 260],
      [300, 340],
      [384, 300],
    ] as const) {
      const rgba = new Uint8ClampedArray(W * H * 4);
      let expected = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const inside =
            Math.hypot((x - W / 2) / (W * 0.26), (y - H / 2) / (H * 0.32)) <= 1;
          if (inside) expected++;
          const n = noise(x * 3.1 + y * 7.7);
          const base = inside ? 196 : 224;
          const i = (y * W + x) * 4;
          rgba[i] = base + n;
          rgba[i + 1] = base + 3 + n;
          rgba[i + 2] = base + 7 + n;
          rgba[i + 3] = 255;
        }
      }
      const { mask } = segment(rgba, W, H, {});
      const found = mask.reduce((a: number, b: number) => a + b, 0);
      expect(found).toBeGreaterThan(expected * 0.8);
      expect(found).toBeLessThan(expected * 1.25);
    }
  });

  it('keeps a thin protrusion instead of smoothing it away', () => {
    const W = 200;
    const H = 200;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const truth = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const body = Math.hypot((x - W * 0.4) / (W * 0.2), (y - H / 2) / (H * 0.26)) <= 1;
        const handle = x > W * 0.58 && x < W * 0.8 && Math.abs(y - H / 2) < H * 0.04;
        const inside = body || handle;
        truth[y * W + x] = inside ? 1 : 0;
        const i = (y * W + x) * 4;
        rgba[i] = inside ? 60 : 240;
        rgba[i + 1] = inside ? 120 : 241;
        rgba[i + 2] = inside ? 180 : 244;
        rgba[i + 3] = 255;
      }
    }
    const { mask } = segment(rgba, W, H, { threshold: 0.5 });
    // The far tip of the handle has to survive.
    const tip = Math.round(H / 2) * W + Math.round(W * 0.77);
    expect(mask[tip]).toBe(1);
  });

  it('honours painted hints as hard constraints', () => {
    const { rgba, width, height } = makeTestImage(64, 64);
    const hints = new Uint8Array(width * height);
    hints[2 * width + 2] = 1; // force a background corner to be kept
    hints[32 * width + 32] = 2; // force the centre to be dropped
    const { mask } = segment(rgba, width, height, { hints, minComponentFraction: 0 });
    expect(mask[2 * width + 2]).toBe(1);
    expect(mask[32 * width + 32]).toBe(0);
  });
});

/** Build a simple filled box of voxels. */
function boxGrid(sx: number, sy: number, sz: number, color = 0) {
  const grid = new VoxelGrid(sx, sy, sz);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) grid.set(x, y, z, color);
  return grid;
}

describe('tiling', () => {
  it('covers every voxel exactly once', () => {
    const grid = boxGrid(9, 9, 7, 0);
    const { placements } = tileGrid(grid, new Uint8Array(grid.cells.length), PALETTE, {
      useBricks: true,
      restarts: 2,
      seed: 7,
    });

    const covered = new Int32Array(grid.cells.length);
    for (const p of placements) {
      for (let y = p.y; y < p.y + p.height; y++) {
        for (let dz = 0; dz < p.d; dz++) {
          for (let dx = 0; dx < p.w; dx++) {
            covered[grid.index(p.x + dx, y, p.z + dz)]++;
          }
        }
      }
    }
    for (let i = 0; i < grid.cells.length; i++) {
      expect(covered[i]).toBe(grid.cells[i] === EMPTY ? 0 : 1);
    }
  });

  it('only ever emits catalogued elements', () => {
    const grid = boxGrid(11, 6, 5, 1);
    const { placements } = tileGrid(grid, new Uint8Array(grid.cells.length), PALETTE, {
      useBricks: true,
      restarts: 2,
      seed: 3,
    });
    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) {
      expect(findPart(p.w, p.d, p.height)).toBeDefined();
    }
  });

  it('staggers joints rather than stacking them', () => {
    const grid = boxGrid(16, 16, 4, 2);
    const { seamAlignment } = tileGrid(grid, new Uint8Array(grid.cells.length), PALETTE, {
      useBricks: true,
      restarts: 4,
      seed: 11,
    });
    // A model that simply repeated the same tiling would score 1.0 here.
    expect(seamAlignment).toBeLessThan(0.35);
  });

  it('prefers bricks over plates where a course is uniform', () => {
    const grid = boxGrid(8, 9, 4, 0);
    const { placements } = tileGrid(grid, new Uint8Array(grid.cells.length), PALETTE, {
      useBricks: true,
      restarts: 2,
      seed: 5,
    });
    const bricks = placements.filter((p) => p.height === 3).length;
    expect(bricks).toBe(placements.length);
  });
});

describe('stability', () => {
  const dims = { sx: 6, sy: 6, sz: 6 };

  it('treats side-by-side parts in one layer as separate assemblies', () => {
    const parts: Placement[] = [
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 1, y: 0, z: 0, color: 4 },
    ];
    expect(countAssemblies(parts, dims)).toBe(2);
  });

  it('joins them once a part bridges the gap above', () => {
    const parts: Placement[] = [
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 1, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x2', code: '3004', w: 2, d: 1, height: 3, x: 0, y: 3, z: 0, color: 4 },
    ];
    expect(countAssemblies(parts, dims)).toBe(1);
  });

  it('props up a part that nothing holds at all', () => {
    const parts: Placement[] = [
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 4, y: 3, z: 4, color: 4 },
    ];
    const added = addSupports(parts, dims);
    expect(added).toBeGreaterThan(0);

    const report = analyseStability({
      placements: parts,
      dims,
      seamAlignment: 0,
      removedFragments: 0,
      supportsAdded: added,
      tiesRecoloured: 0,
    });
    expect(report.issues.filter((i) => i.kind === 'floating' && i.at).length).toBe(0);
  });

  it('leaves an overhang alone when the course above clamps it', () => {
    // A plate hanging off the edge, with a brick above bridging it back to
    // solid ground. That is a real technique, not a defect.
    const parts: Placement[] = [
      { partId: 'brick-1x2', code: '3004', w: 2, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'plate-1x2', code: '3023', w: 2, d: 1, height: 1, x: 0, y: 3, z: 0, color: 4 },
      { partId: 'plate-1x1', code: '3024', w: 1, d: 1, height: 1, x: 2, y: 3, z: 0, color: 4 },
      { partId: 'plate-1x4', code: '3710', w: 4, d: 1, height: 1, x: 0, y: 4, z: 0, color: 4 },
    ];
    const added = addSupports(parts, dims);
    expect(added).toBe(0);

    const report = analyseStability({
      placements: parts,
      dims,
      seamAlignment: 0,
      removedFragments: 0,
      supportsAdded: 0,
      tiesRecoloured: 0,
    });
    expect(report.cantilevered).toBe(1);
    expect(report.assemblies).toBe(1);
    expect(parts[2].needsHold).toBe(true);
    // Flagged for the builder, but not counted as a structural failure.
    expect(report.issues.some((i) => i.kind === 'floating')).toBe(false);
    expect(report.score).toBeGreaterThan(85);
  });

  it('scores a well-bonded solid higher than a stack of aligned columns', () => {
    const solid = analyseStability({
      placements: [
        { partId: 'brick-2x4', code: '3001', w: 4, d: 2, height: 3, x: 0, y: 0, z: 0, color: 4 },
        { partId: 'brick-2x4', code: '3001', w: 4, d: 2, height: 3, x: 0, y: 3, z: 0, color: 4 },
      ],
      dims,
      seamAlignment: 0.05,
      removedFragments: 0,
      supportsAdded: 0,
      tiesRecoloured: 0,
    });
    const weak = analyseStability({
      placements: [
        { partId: 'brick-2x4', code: '3001', w: 4, d: 2, height: 3, x: 0, y: 0, z: 0, color: 4 },
        { partId: 'brick-2x4', code: '3001', w: 4, d: 2, height: 3, x: 0, y: 3, z: 0, color: 4 },
      ],
      dims,
      seamAlignment: 0.9,
      removedFragments: 0,
      supportsAdded: 0,
      tiesRecoloured: 0,
    });
    expect(solid.score).toBeGreaterThan(weak.score);
  });
});

describe('shape modes', () => {
  const { rgba, width, height } = makeTestImage(96, 96);
  const mask = discMask(width, height);
  const run = (patch: Partial<typeof DEFAULT_OPTIONS>) =>
    generateModel([{ rgba, mask, width, height, azimuth: 0 }], {
      ...DEFAULT_OPTIONS,
      studsWide: 16,
      seed: 5,
      ...patch,
    });

  it('turns a silhouette into a solid of revolution', () => {
    const result = run({ solidMode: 'revolve' });
    // Revolving a circle gives a sphere: as deep as it is wide.
    expect(result.gridZ).toBe(result.gridX);
    expect(result.totalParts).toBeGreaterThan(0);
    expect(result.stability.assemblies).toBe(1);

    // A horizontal slice through the middle should be round, not square: the
    // corners of the bounding box must be empty.
    const midY = Math.floor(result.gridY / 2);
    const filled = new Set<string>();
    for (const p of result.placements) {
      if (p.y > midY || p.y + p.height <= midY) continue;
      for (let dz = 0; dz < p.d; dz++) {
        for (let dx = 0; dx < p.w; dx++) filled.add(`${p.x + dx},${p.z + dz}`);
      }
    }
    expect(filled.has('0,0')).toBe(false);
    expect(filled.has(`${result.gridX - 1},${result.gridZ - 1}`)).toBe(false);
    expect(filled.size).toBeGreaterThan(0);
  });

  it('builds a relief with a flat back', () => {
    const result = run({ solidMode: 'relief' });
    // Everything starts at the back plane, so z = 0 is always occupied.
    const minZ = Math.min(...result.placements.map((p) => p.z));
    expect(minZ).toBe(0);
    expect(result.stability.assemblies).toBe(1);
  });

  it('keeps a rounded solid symmetric about its centre plane', () => {
    const result = run({ solidMode: 'symmetric', hollow: false });
    const midY = Math.floor(result.gridY / 2);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of result.placements) {
      if (p.y > midY || p.y + p.height <= midY) continue;
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z + p.d - 1);
    }
    // The thickest slice should straddle the middle of the depth axis.
    const centre = (result.gridZ - 1) / 2;
    expect(Math.abs((minZ + maxZ) / 2 - centre)).toBeLessThanOrEqual(1);
  });

  it('gives a plate-resolution build finer vertical steps than a brick one', () => {
    const bricks = run({ resolution: 'bricks' });
    const mixed = run({ resolution: 'mixed' });
    expect(mixed.placements.some((p) => p.height === 1)).toBe(true);
    expect(bricks.placements.every((p) => p.height === 3)).toBe(true);
    // Detail is not free, and the report should show that it is not.
    expect(bricks.totalParts).toBeLessThan(mixed.totalParts);
  });
});

describe('multi-view shape recovery', () => {
  const PX = 180;
  const W = 200;
  const H = 260;

  /** A box of half-extents a (x) and b (z), photographed from `azimuth`. */
  function boxView(a: number, b: number, azimuth: number) {
    const t = (azimuth * Math.PI) / 180;
    const halfW = Math.abs(a * Math.cos(t)) + Math.abs(b * Math.sin(t));
    const rgba = new Uint8ClampedArray(W * H * 4);
    const mask = new Uint8Array(W * H);
    const top = (H - PX) / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = y >= top && y < top + PX && Math.abs(x - W / 2) <= halfW * PX;
        mask[y * W + x] = inside ? 1 : 0;
        const i = (y * W + x) * 4;
        rgba[i] = inside ? 200 : 240;
        rgba[i + 1] = inside ? 60 : 242;
        rgba[i + 2] = inside ? 60 : 245;
        rgba[i + 3] = 255;
      }
    }
    return { rgba, mask, width: W, height: H, azimuth };
  }

  /** Extent of the carved shape at mid height, in studs. */
  function midSlice(hull: NonNullable<ReturnType<typeof carveVisualHull>>) {
    const gy = Math.floor(hull.sy / 2);
    let minX = hull.sx;
    let maxX = -1;
    let minZ = hull.sz;
    let maxZ = -1;
    let filled = 0;
    for (let gz = 0; gz < hull.sz; gz++) {
      for (let gx = 0; gx < hull.sx; gx++) {
        if (!hull.occupancy[(gy * hull.sz + gz) * hull.sx + gx]) continue;
        filled++;
        minX = Math.min(minX, gx);
        maxX = Math.max(maxX, gx);
        minZ = Math.min(minZ, gz);
        maxZ = Math.max(maxZ, gz);
      }
    }
    return { x: maxX - minX + 1, z: maxZ - minZ + 1, filled };
  }

  it('cannot know the depth of an object from one photo', () => {
    // The honest baseline: one silhouette extrudes to a slab, so a box twice as
    // wide as it is deep comes out square. This is the limitation multi-view
    // exists to remove.
    const hull = carveVisualHull([boxView(0.3, 0.15, 0)], { studsWide: 24, tolerance: 0 })!;
    const slice = midSlice(hull);
    expect(slice.x / slice.z).toBeLessThan(1.2);
  });

  it('recovers the true proportions from two perpendicular photos', () => {
    const hull = carveVisualHull([boxView(0.3, 0.15, 0), boxView(0.3, 0.15, 90)], {
      studsWide: 24,
      tolerance: 0,
    })!;
    const slice = midSlice(hull);
    // The object really is 2:1.
    expect(slice.x / slice.z).toBeGreaterThan(1.8);
    expect(slice.x / slice.z).toBeLessThan(2.2);
  });

  /**
   * A cylinder, whose silhouette is the same width from every angle. Note this
   * is not a rotated box: a box seen from 45 degrees is *wider* than head on,
   * and that extra width is exactly what stops its corners being carved away.
   */
  function cylinderView(r: number, azimuth: number) {
    const view = boxView(r, r, 0);
    return { ...view, azimuth };
  }

  it('rounds a cylinder off as more angles are added', () => {
    const round = (k: number) => {
      const views = Array.from({ length: k }, (_, i) => cylinderView(0.25, (i * 180) / k));
      const hull = carveVisualHull(views, { studsWide: 24, tolerance: 0 })!;
      const slice = midSlice(hull);
      return slice.filled / (slice.x * slice.z);
    };
    // Two views can only give a square prism, which fills its bounding box.
    expect(round(2)).toBeGreaterThan(0.95);
    // Eight views approach a circle, which fills pi/4 = 79% of it.
    expect(round(8)).toBeLessThan(0.85);
    expect(round(8)).toBeGreaterThan(0.72);
  });

  it('is unchanged by views that repeat information already had', () => {
    // A box looks the same from the front and from behind, so adding the
    // opposite pair tells the carve nothing new and must not disturb it.
    const two = carveVisualHull([boxView(0.3, 0.15, 0), boxView(0.3, 0.15, 90)], {
      studsWide: 24,
      tolerance: 0,
    })!;
    const four = carveVisualHull(
      [
        boxView(0.3, 0.15, 0),
        boxView(0.3, 0.15, 90),
        boxView(0.3, 0.15, 180),
        boxView(0.3, 0.15, 270),
      ],
      { studsWide: 24, tolerance: 0 },
    )!;
    expect(midSlice(four).x).toBe(midSlice(two).x);
    expect(midSlice(four).z).toBe(midSlice(two).z);
  });

  it('builds a buildable model from several views', () => {
    const result = generateModel(
      [boxView(0.3, 0.15, 0), boxView(0.3, 0.15, 90), boxView(0.3, 0.15, 180)],
      { ...DEFAULT_OPTIONS, studsWide: 18, seed: 4 },
    );
    expect(result.geometry).toBe('visual-hull');
    expect(result.viewsUsed).toBe(3);
    expect(result.stability.assemblies).toBe(1);
    expect(result.stability.score).toBeGreaterThanOrEqual(80);

    // The built model really is half as deep as it is wide. The grid itself is
    // square — it has to hold the object at any rotation — so this has to be
    // measured on the parts, not the grid.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of result.placements) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + p.w);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z + p.d);
    }
    const ratio = (maxX - minX) / (maxZ - minZ);
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.3);
  });

  it('falls back to extrusion when there is only one photo', () => {
    const result = generateModel([boxView(0.3, 0.15, 0)], {
      ...DEFAULT_OPTIONS,
      studsWide: 18,
    });
    expect(result.geometry).toBe('extruded');
    expect(result.viewsUsed).toBe(1);
  });
});

describe('the unseen far side', () => {
  /**
   * A head: skin in the middle, hair around the outside, dark eyes. Only the
   * hair genuinely wraps round the back — the eyes must not appear there.
   */
  function makeHead(width: number, height: number) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const nx = (x - width / 2) / (width * 0.32);
        const ny = (y - height / 2) / (height * 0.42);
        const inside = nx * nx + ny * ny <= 1;
        mask[y * width + x] = inside ? 1 : 0;
        rgba[i + 3] = 255;
        if (!inside) {
          rgba[i] = 238;
          rgba[i + 1] = 240;
          rgba[i + 2] = 243;
          continue;
        }
        if (Math.hypot(nx, ny) > 0.62) {
          rgba[i] = 70; // hair
          rgba[i + 1] = 42;
          rgba[i + 2] = 20;
        } else {
          rgba[i] = 232; // skin
          rgba[i + 1] = 190;
          rgba[i + 2] = 150;
        }
      }
    }
    return { rgba, mask, width, height };
  }

  const head = makeHead(180, 220);
  const run = (backTreatment: BuildOptions['backTreatment']) =>
    generateModel([{ rgba: head.rgba, mask: head.mask, width: head.width, height: head.height, azimuth: 0 }], {
      ...DEFAULT_OPTIONS,
      studsWide: 24,
      hollow: false,
      backTreatment,
      seed: 9,
    });

  /** Colours visible looking at the model from the front, or from behind. */
  function surfaceColours(result: ReturnType<typeof run>, from: 'front' | 'back') {
    const { gridX: sx, gridY: sy, gridZ: sz } = result;
    const grid = new Int32Array(sx * sy * sz).fill(-1);
    for (const p of result.placements) {
      for (let y = p.y; y < p.y + p.height; y++) {
        for (let dz = 0; dz < p.d; dz++) {
          for (let dx = 0; dx < p.w; dx++) {
            grid[(y * sz + (p.z + dz)) * sx + (p.x + dx)] = p.color;
          }
        }
      }
    }
    const seen = new Map<number, number>();
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        let found = -1;
        for (let k = 0; k < sz; k++) {
          const z = from === 'front' ? k : sz - 1 - k;
          const v = grid[(y * sz + z) * sx + x];
          if (v >= 0) {
            found = v;
            break;
          }
        }
        if (found >= 0) seen.set(found, (seen.get(found) ?? 0) + 1);
      }
    }
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    const share = new Map<string, number>();
    for (const [code, n] of seen) {
      share.set(COLOR_BY_LDRAW.get(code)?.name ?? String(code), n / total);
    }
    return share;
  }

  const skinish = (name: string) => /Nougat|Tan/.test(name);

  it('does not paint the front of the face onto the back', () => {
    const wrapped = run('wrap');
    const front = surfaceColours(wrapped, 'front');
    const back = surfaceColours(wrapped, 'back');

    // Skin dominates the front...
    const frontSkin = [...front].filter(([n]) => skinish(n)).reduce((a, [, v]) => a + v, 0);
    expect(frontSkin).toBeGreaterThan(0.2);

    // ...and must be essentially absent from the back, which sees only the
    // hair that genuinely wraps round.
    const backSkin = [...back].filter(([n]) => skinish(n)).reduce((a, [, v]) => a + v, 0);
    expect(backSkin).toBeLessThan(0.02);
  });

  it('still mirrors the face onto the back when explicitly asked to', () => {
    // The old behaviour, kept as an option. Asserted so the difference between
    // the treatments stays visible: this is exactly what 'wrap' avoids.
    const back = surfaceColours(run('mirror'), 'back');
    const backSkin = [...back].filter(([n]) => skinish(n)).reduce((a, [, v]) => a + v, 0);
    expect(backSkin).toBeGreaterThan(0.2);
  });

  it('gives a plain back a single colour', () => {
    const back = surfaceColours(run('flat'), 'back');
    expect(back.size).toBe(1);
  });

  it('leaves the photographed side untouched whichever guess is used', () => {
    const wrapped = surfaceColours(run('wrap'), 'front');
    const flat = surfaceColours(run('flat'), 'front');
    for (const [name, share] of wrapped) {
      expect(flat.get(name) ?? 0).toBeCloseTo(share, 5);
    }
  });

  it('costs nothing structurally: the far side is a guess, not a weakness', () => {
    for (const treatment of ['wrap', 'flat', 'mirror'] as const) {
      const result = run(treatment);
      expect(result.stability.assemblies).toBe(1);
      expect(result.stability.score).toBeGreaterThanOrEqual(85);
      expect(result.fidelity.silhouetteIoU).toBeGreaterThan(0.9);
    }
  });
});

describe('assembly repair', () => {
  it('re-cuts a run so a stranded neighbour becomes part of one piece', () => {
    const dims = { sx: 8, sy: 8, sz: 4 };
    // Bottom course: a 1x4 and a 1x1 lying side by side. They touch, but in
    // real bricks they are two loose pieces. The 1x1 has nothing above it
    // either, so only re-cutting the run can join them.
    const parts: Placement[] = [
      { partId: 'brick-1x4', code: '3010', w: 4, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 4, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x3', code: '3622', w: 3, d: 1, height: 3, x: 0, y: 3, z: 0, color: 4 },
    ];
    expect(countAssemblies(parts, dims)).toBe(2);

    const { merged, removed } = repairAssemblies(parts, dims);
    expect(merged).toBeGreaterThan(0);
    expect(removed).toBe(0);
    expect(countAssemblies(parts, dims)).toBe(1);

    // Same studs, same colour, just cut differently.
    const bottom = parts.filter((p) => p.y === 0);
    expect(bottom.reduce((n, p) => n + p.w * p.d, 0)).toBe(5);
    for (const p of parts) expect(findPart(p.w, p.d, p.height)).toBeDefined();
  });

  it('discards a stray it cannot possibly join', () => {
    const dims = { sx: 8, sy: 4, sz: 4 };
    // Five studs in one isolated layer: there is no 1x5 brick, so no re-cut
    // can ever make this one piece. The spur has to go.
    const parts: Placement[] = [
      { partId: 'brick-1x4', code: '3010', w: 4, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 4, y: 0, z: 0, color: 4 },
    ];
    const { removed } = repairAssemblies(parts, dims);
    expect(removed).toBe(1);
    expect(countAssemblies(parts, dims)).toBe(1);
    expect(parts).toHaveLength(1);
  });

  it('leaves a model that is already one piece alone', () => {
    const dims = { sx: 6, sy: 6, sz: 6 };
    const parts: Placement[] = [
      { partId: 'brick-2x4', code: '3001', w: 4, d: 2, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-2x4', code: '3001', w: 4, d: 2, height: 3, x: 0, y: 3, z: 0, color: 4 },
    ];
    const before = parts.length;
    const { merged, removed } = repairAssemblies(parts, dims);
    expect(merged).toBe(0);
    expect(removed).toBe(0);
    expect(parts.length).toBe(before);
  });
});

describe('hollowing', () => {
  it('measures the shell in millimetres, not voxels', () => {
    // 10 studs wide and deep, 30 plates (10 courses) tall.
    const grid = boxGrid(10, 30, 10, 0);
    const before = grid.count();
    const removed = hollow(grid, 16, 3, true);

    expect(removed).toBeGreaterThan(0);
    expect(grid.count()).toBe(before - removed);
    // Still a single connected shell, not a set of loose panels.
    expect(labelComponents(grid).sizes.length - 1).toBe(1);

    // A 16mm shell is 2 studs sideways and 5 plates vertically, so the very
    // middle must be gone but a cell one stud in from the wall must remain.
    expect(grid.get(5, 15, 5)).toBe(EMPTY);
    expect(grid.get(1, 15, 5)).not.toBe(EMPTY);
  });

  it('refuses to hollow something too small to have an interior', () => {
    expect(shouldHollow(boxGrid(3, 9, 3), 16)).toBe(false);
    expect(shouldHollow(boxGrid(20, 60, 20), 16)).toBe(true);
  });
});

describe('build steps', () => {
  const parts: Placement[] = [
    { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 3, z: 0, color: 4 },
    { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 1, y: 0, z: 0, color: 4 },
    { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
  ];

  it('orders parts bottom-up', () => {
    const ordered = orderPlacements(parts);
    expect(ordered.map((p) => p.y)).toEqual([0, 0, 3]);
  });

  it('never introduces a part before the layer below is complete', () => {
    const steps = buildSteps(parts, 1);
    let previousY = -1;
    for (const step of steps) {
      for (const p of step.placements) {
        expect(p.y).toBeGreaterThanOrEqual(previousY);
        previousY = p.y;
      }
    }
    expect(steps.at(-1)!.cumulativeParts).toBe(parts.length);
  });
});

describe('LDraw export', () => {
  it('writes one line per part with the right element and position', () => {
    const steps = buildSteps(
      [{ partId: 'brick-2x4', code: '3001', w: 4, d: 2, height: 3, x: 0, y: 0, z: 0, color: 4 }],
      8,
    );
    const text = toLdraw(steps, { modelName: 'test' });
    const line = text.split('\n').find((l) => l.startsWith('1 '))!;
    const fields = line.split(' ');
    expect(fields[1]).toBe('4'); // colour
    expect(fields[2]).toBe('40'); // x: 2 studs from origin = 40 LDU
    expect(fields[3]).toBe('0'); // y: bottom course
    expect(fields[4]).toBe('20'); // z: 1 stud
    expect(fields.at(-1)).toBe('3001.dat');
  });

  it('rotates parts whose long side runs along Z', () => {
    const steps = buildSteps(
      [{ partId: 'brick-2x4', code: '3001', w: 2, d: 4, height: 3, x: 0, y: 0, z: 0, color: 4 }],
      8,
    );
    const line = toLdraw(steps).split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toContain('0 0 1 0 1 0 -1 0 0');
  });

  it('emits a STEP marker between steps but not after the last', () => {
    const parts: Placement[] = [
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 3, z: 0, color: 4 },
    ];
    const steps = buildSteps(parts, 1);
    const text = toLdraw(steps);
    expect(text.split('\n').filter((l) => l === '0 STEP')).toHaveLength(steps.length - 1);
  });
});

describe('bill of materials', () => {
  it('aggregates identical elements and keeps colours apart', () => {
    const parts: Placement[] = [
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 0, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 1, y: 0, z: 0, color: 4 },
      { partId: 'brick-1x1', code: '3005', w: 1, d: 1, height: 3, x: 2, y: 0, z: 0, color: 15 },
    ];
    const list = buildPartsList(parts);
    expect(list).toHaveLength(2);
    expect(list[0].count).toBe(2);
    expect(list[0].colorName).toBe('Red');
  });
});

describe('end to end', () => {
  const { rgba, width, height } = makeTestImage(128, 128);
  const mask = discMask(width, height);
  const result = generateModel([{ rgba, mask, width, height, azimuth: 0 }], {
    ...DEFAULT_OPTIONS,
    studsWide: 20,
    partsPerStep: 6,
    seed: 42,
  });

  it('produces a model, a manual and a parts list', () => {
    expect(result.placements.length).toBeGreaterThan(20);
    expect(result.steps.length).toBeGreaterThan(1);
    expect(result.totalParts).toBe(result.placements.length);
    expect(result.partsList.reduce((n, e) => n + e.count, 0)).toBe(result.totalParts);
  });

  it('keeps the object round rather than stretching it', () => {
    // A circle 20 studs wide is 160mm across, so it should be ~160mm tall too.
    expect(result.dimensionsMM.height).toBeGreaterThan(result.dimensionsMM.width * 0.85);
    expect(result.dimensionsMM.height).toBeLessThan(result.dimensionsMM.width * 1.15);
  });

  it('resembles the photo', () => {
    expect(result.fidelity.silhouetteIoU).toBeGreaterThan(0.9);
    expect(result.fidelity.meanDeltaE).toBeLessThan(20);
  });

  it('holds together and stands on the ground', () => {
    expect(result.stability.score).toBeGreaterThanOrEqual(85);
    expect(result.stability.grounded).toBe(true);
    expect(result.stability.assemblies).toBe(1);
    expect(result.stability.issues.some((i) => i.kind === 'floating')).toBe(false);
  });

  it('leaves nothing unheld: every part rests on or hangs from another', () => {
    const dims = { sx: result.gridX, sy: result.gridY, sz: result.gridZ };
    expect(countAssemblies(result.placements, dims)).toBe(1);
  });

  it('reaches the ground everywhere it needs to', () => {
    const lowest = Math.min(...result.placements.map((p) => p.y));
    expect(lowest).toBe(0);
  });

  it('is reproducible for a given seed', () => {
    const again = generateModel([{ rgba, mask, width, height, azimuth: 0 }], {
      ...DEFAULT_OPTIONS,
      studsWide: 20,
      partsPerStep: 6,
      seed: 42,
    });
    expect(again.totalParts).toBe(result.totalParts);
    expect(again.steps.length).toBe(result.steps.length);
  });

  it('exports LDraw that references only real elements', () => {
    const text = toLdraw(result.steps);
    const parts = text
      .split('\n')
      .filter((l) => l.startsWith('1 '))
      .map((l) => l.split(' ').at(-1));
    expect(parts.length).toBe(result.totalParts);
    const known = new Set(ALL_PARTS.map((p) => `${p.code}.dat`));
    for (const p of parts) expect(known.has(p!)).toBe(true);
  });
});

describe('prompting the segmentation model', () => {
  it('never proposes a box that fills the frame', () => {
    // SAM answers "what object is in this box". A box covering everything is
    // the question "what is this scene", and it answers with the background —
    // measured at 1.1% IoU, so this is the difference between working and not.
    const box = clampBox({ x0: 0, y0: 0, x1: 199, y1: 199 }, 200, 200);
    expect(box.x1 - box.x0).toBeLessThanOrEqual(200 * 0.85);
    expect(box.y1 - box.y0).toBeLessThanOrEqual(200 * 0.85);
  });

  it('keeps a sensible box untouched', () => {
    const original = { x0: 40, y0: 30, x1: 120, y1: 150 };
    const box = clampBox(original, 200, 200);
    expect(box).toEqual(original);
  });

  it('shrinks around the centre rather than the corner', () => {
    const box = clampBox({ x0: 0, y0: 0, x1: 199, y1: 199 }, 200, 200, 0.5);
    expect((box.x0 + box.x1) / 2).toBeCloseTo(99.5, 1);
    expect((box.y0 + box.y1) / 2).toBeCloseTo(99.5, 1);
  });

  it('keeps a clamped box inside the frame', () => {
    // A proposal hugging one edge must not be recentred off the image.
    const box = clampBox({ x0: 150, y0: 150, x1: 199, y1: 199 }, 200, 200, 0.9);
    expect(box.x0).toBeGreaterThanOrEqual(0);
    expect(box.y0).toBeGreaterThanOrEqual(0);
    expect(box.x1).toBeLessThanOrEqual(200);
    expect(box.y1).toBeLessThanOrEqual(200);
  });

  it('proposes a box around the object, not the whole picture', () => {
    const width = 120;
    const height = 120;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const inside = x >= 40 && x < 80 && y >= 35 && y < 85;
        rgba[i] = inside ? 200 : 40;
        rgba[i + 1] = inside ? 60 : 40;
        rgba[i + 2] = inside ? 60 : 45;
        rgba[i + 3] = 255;
      }
    }
    const box = proposeBox(rgba, width, height);
    // Contains the object...
    expect(box.x0).toBeLessThanOrEqual(41);
    expect(box.x1).toBeGreaterThanOrEqual(78);
    expect(box.y0).toBeLessThanOrEqual(36);
    expect(box.y1).toBeGreaterThanOrEqual(83);
    // ...without swallowing the frame.
    expect((box.x1 - box.x0) * (box.y1 - box.y0)).toBeLessThan(width * height * 0.75);
  });

  it('samples brush strokes into a bounded set of points of both kinds', () => {
    const width = 100;
    const height = 100;
    const hints = new Uint8Array(width * height);
    for (let y = 10; y < 60; y++) for (let x = 10; x < 60; x++) hints[y * width + x] = 1;
    for (let y = 70; y < 95; y++) for (let x = 70; x < 95; x++) hints[y * width + x] = 2;

    const points = hintsToPoints(hints, width, height, 5);
    expect(points.filter((p) => p.label === 1).length).toBeGreaterThan(0);
    expect(points.filter((p) => p.label === 0).length).toBeGreaterThan(0);
    expect(points.filter((p) => p.label === 1).length).toBeLessThanOrEqual(5);
    expect(points.filter((p) => p.label === 0).length).toBeLessThanOrEqual(5);
    for (const p of points) {
      expect(hints[p.y * width + p.x]).toBe(p.label === 1 ? 1 : 2);
    }
  });

  it('has no points to make when nothing is painted', () => {
    expect(hintsToPoints(null, 10, 10)).toEqual([]);
    expect(hintsToPoints(new Uint8Array(100), 10, 10)).toEqual([]);
  });
});

describe('the segmentation benchmark', () => {
  it('builds the same corpus every time', () => {
    const a = buildCorpus({ width: 64, height: 64 });
    const b = buildCorpus({ width: 64, height: 64 });
    expect(a.length).toBe(b.length);
    expect(Array.from(a[0].rgba)).toEqual(Array.from(b[0].rgba));
    expect(Array.from(a[0].truth)).toEqual(Array.from(b[0].truth));
  });

  it('varies the background while holding the object fixed', () => {
    const scenes = buildCorpus({ width: 64, height: 64 });
    const mug = scenes.filter((s) => s.object === 'mug');
    expect(mug.length).toBeGreaterThan(1);
    // Same object, same truth — only what is behind it changes.
    expect(Array.from(mug[0].truth)).toEqual(Array.from(mug[1].truth));
    expect(Array.from(mug[0].rgba)).not.toEqual(Array.from(mug[1].rgba));
  });

  it('leaves the cast shadow out of the truth mask', () => {
    // The shadow is offset down and right of the object. If it ever leaked
    // into the truth, every method would be scored against the wrong answer.
    const scene = buildCorpus({ width: 96, height: 96 }).find((s) => s.object === 'book')!;
    let truthCount = 0;
    for (let i = 0; i < scene.truth.length; i++) truthCount += scene.truth[i];
    expect(truthCount).toBeGreaterThan(0);
    expect(truthCount).toBeLessThan(scene.width * scene.height * 0.6);
  });

  it('scores a perfect mask perfectly and an empty one at zero', () => {
    const scene = buildCorpus({ width: 64, height: 64 })[0];
    const perfect = score(scene.truth, scene.truth, scene.width, scene.height);
    expect(perfect.iou).toBeCloseTo(1, 6);
    expect(perfect.boundaryF1).toBeCloseTo(1, 6);

    const empty = score(new Uint8Array(scene.truth.length), scene.truth, scene.width, scene.height);
    expect(empty.iou).toBe(0);
  });

  it('penalises a two-pixel offset that IoU alone barely notices', () => {
    // This is the whole reason boundary F1 is reported: an outline that is
    // wrong everywhere by a couple of pixels still scores well on IoU, and a
    // couple of pixels is a whole stud once the model is carved.
    const w = 64;
    const h = 64;
    const truth = new Uint8Array(w * h);
    const shifted = new Uint8Array(w * h);
    for (let y = 16; y < 48; y++) {
      for (let x = 16; x < 48; x++) {
        truth[y * w + x] = 1;
        shifted[(y + 3) * w + (x + 3)] = 1;
      }
    }
    const s = score(shifted, truth, w, h, 1);
    expect(s.iou).toBeGreaterThan(0.6);
    expect(s.boundaryF1).toBeLessThan(0.5);
  });
});

describe('depth from a single photograph', () => {
  it('makes a sphere about as deep as it is wide', () => {
    // The old default made every single-view model roughly half as deep as it
    // should be: correct head-on, wrong the moment you orbited it. One photo
    // cannot measure depth, so this is a prior — but it has to be a sane one.
    const solid = SOLIDS.find((s) => s.name === 'sphere')!;
    const result = generateModel([renderView(solid, 0)], {
      ...DEFAULT_OPTIONS,
      studsWide: 16,
      hollow: false,
    });
    const ratio = result.gridZ / result.gridX;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThanOrEqual(1.05);
  });

  it('spreads benchmark views over half a turn, not a full one', () => {
    // Under orthographic projection a silhouette and its opposite are mirror
    // images, so 0 and 180 constrain the hull identically — a pair of views
    // spread over 360 degrees carries the information of one.
    expect(azimuthsFor(2)).toEqual([0, 90]);
    expect(azimuthsFor(4)).toEqual([0, 45, 90, 135]);
  });

  it('carves a genuinely deeper solid from two views than it guesses from one', () => {
    const solid = SOLIDS.find((s) => s.name === 'cylinder')!;
    const opts = { ...DEFAULT_OPTIONS, studsWide: 14, hollow: false };
    const one = generateModel([renderView(solid, 0)], opts);
    const two = generateModel(azimuthsFor(2).map((a) => renderView(solid, a)), opts);
    expect(one.geometry).toBe('extruded');
    expect(two.geometry).toBe('visual-hull');
    // A cylinder is as deep as it is wide; both should get close, but only the
    // two-view answer is measured rather than assumed.
    expect(two.gridZ / two.gridX).toBeGreaterThan(0.85);
  });
});

describe('recognising what the object is', () => {
  const indexOf = (name: string) => CLASS_NAMES.indexOf(name);

  it('maps everyday objects to the shape they actually are', () => {
    expect(ARCHETYPE_BY_CLASS[indexOf('coffee mug')]).toBe('T');
    expect(ARCHETYPE_BY_CLASS[indexOf('wine bottle')]).toBe('T');
    expect(ARCHETYPE_BY_CLASS[indexOf('vase')]).toBe('T');
    expect(ARCHETYPE_BY_CLASS[indexOf('binder')]).toBe('F');
    expect(ARCHETYPE_BY_CLASS[indexOf('envelope')]).toBe('F');
    expect(ARCHETYPE_BY_CLASS[indexOf('ping-pong ball')]).toBe('R');
    expect(ARCHETYPE_BY_CLASS[indexOf('teddy')]).toBe('R');
    expect(ARCHETYPE_BY_CLASS[indexOf('folding chair')]).toBe('B');
  });

  it('covers every class exactly once', () => {
    expect(ARCHETYPE_BY_CLASS.length).toBe(1000);
    expect(CLASS_NAMES.length).toBe(1000);
    expect([...new Set(ARCHETYPE_BY_CLASS)].sort().join('')).toBe('BFRTU');
  });

  it('treats animals as rounded bodies rather than slabs', () => {
    // ImageNet is ordered by wnid and the first 398 classes are animals; a
    // photographed animal or soft toy is round, never flat.
    for (const name of ['tench', 'goldfish', 'tabby', 'Siamese cat']) {
      const i = indexOf(name);
      if (i >= 0) expect(ARCHETYPE_BY_CLASS[i]).toBe('R');
    }
  });

  it('turns a confident recognition into a turned profile', () => {
    const prior = shapePriorFor({
      label: 'coffee mug',
      labelConfidence: 0.7,
      archetype: 'T',
      confidence: 0.8,
    });
    expect(prior?.solidMode).toBe('revolve');
    expect(prior?.explanation).toContain('coffee mug');
  });

  it('makes a flat object flat, which is where a geometric prior is worst', () => {
    const prior = shapePriorFor({
      label: 'binder',
      labelConfidence: 0.5,
      archetype: 'F',
      confidence: 0.6,
    });
    expect(prior?.depthScale).toBeLessThan(0.5);
  });

  it('declines to guess when it is not sure', () => {
    // An unconfident classifier must leave the neutral prior alone rather than
    // swap in a confident-sounding wrong one.
    expect(
      shapePriorFor({ label: 'x', labelConfidence: 0.1, archetype: 'T', confidence: 0.2 }),
    ).toBeNull();
    expect(
      shapePriorFor({ label: 'x', labelConfidence: 0.9, archetype: 'U', confidence: 0.9 }),
    ).toBeNull();
    expect(shapePriorFor(null)).toBeNull();
  });
});

describe('regressions in what the model keeps and what it reports', () => {
  it('keeps the top course when the height is not a multiple of three', () => {
    // snapToCourses runs after the grid is trimmed to its material, so its
    // height is only a multiple of three by luck. Flooring the course count
    // deleted the top one or two plate layers of every model that was not.
    for (const sy of [9, 10, 11, 12]) {
      const grid = new VoxelGrid(4, sy, 4);
      for (let y = 0; y < sy; y++)
        for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) grid.set(x, y, z, 0);

      const snapped = snapToCourses(grid);
      expect(snapped.count()).toBe(grid.count());
      let top = -1;
      for (let y = sy - 1; y >= 0 && top < 0; y--) {
        for (let z = 0; z < 4 && top < 0; z++)
          for (let x = 0; x < 4; x++)
            if (snapped.get(x, y, z) !== EMPTY) {
              top = y;
              break;
            }
      }
      expect(top).toBe(sy - 1);
    }
  });

  it('reports the same colour error however much background surrounds the object', () => {
    // The colour error used to be re-derived by mapping grid columns across the
    // whole image, while the grid had been sampled across the object's bounding
    // box. Padding the photo therefore moved the reported error on a model that
    // had not changed at all.
    const solid = SOLIDS.find((s) => s.name === 'mug')!;
    const base = renderView(solid, 0, 200);

    const pad = (factor: number) => {
      const w = Math.round(base.width * factor);
      const h = Math.round(base.height * factor);
      const ox = Math.round((w - base.width) / 2);
      const oy = Math.round((h - base.height) / 2);
      const rgba = new Uint8ClampedArray(w * h * 4);
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = 120;
        rgba[i * 4 + 1] = 120;
        rgba[i * 4 + 2] = 120;
        rgba[i * 4 + 3] = 255;
      }
      for (let y = 0; y < base.height; y++)
        for (let x = 0; x < base.width; x++) {
          const s = y * base.width + x;
          const d = (y + oy) * w + (x + ox);
          rgba[d * 4] = base.rgba[s * 4];
          rgba[d * 4 + 1] = base.rgba[s * 4 + 1];
          rgba[d * 4 + 2] = base.rgba[s * 4 + 2];
          rgba[d * 4 + 3] = 255;
          mask[d] = base.mask[s];
        }
      return { ...base, rgba, mask, width: w, height: h };
    };

    const options: BuildOptions = { ...DEFAULT_OPTIONS, studsWide: 20 };
    const tight = generateModel([base], options).fidelity.meanDeltaE;
    for (const factor of [1.5, 2.5]) {
      const padded = generateModel([pad(factor)], options).fidelity.meanDeltaE;
      expect(Math.abs(padded - tight)).toBeLessThan(0.5);
    }
  });

  it('counts material the model dropped against the silhouette match', () => {
    // The silhouette used to be cropped to the model's own extent, so anything
    // the model abandoned fell outside the window and stopped counting as
    // missing at all. A speck the cleanup discards has to cost something.
    const width = 240;
    const height = 160;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(200);

    const body = (into: Uint8Array) => {
      for (let y = 30; y < 130; y++) for (let x = 20; x < 120; x++) into[y * width + x] = 1;
    };

    const withSpeck = new Uint8Array(width * height);
    body(withSpeck);
    for (let y = 78; y < 84; y++) for (let x = 210; x < 216; x++) withSpeck[y * width + x] = 1;

    const alone = new Uint8Array(width * height);
    body(alone);

    const options: BuildOptions = { ...DEFAULT_OPTIONS, studsWide: 24 };
    const dropped = generateModel([{ rgba, mask: withSpeck, width, height, azimuth: 0 }], options);
    const clean = generateModel([{ rgba, mask: alone, width, height, azimuth: 0 }], options);

    // Stated as a comparison rather than against a fixed threshold. The old
    // 0.99 was calibrated when the score was measured on the voxel grid and
    // counted support struts as model area, which depressed every number by a
    // few points; measured on the parts, with scaffolding excluded, a clean
    // model scores exactly 1 and the speck costs half a point rather than two.
    // What the test is actually about is that abandoning material is not free.
    expect(clean.fidelity.silhouetteIoU).toBeGreaterThan(0.99);
    expect(dropped.fidelity.silhouetteIoU).toBeLessThan(clean.fidelity.silhouetteIoU);
    // And it now shows up directly, which is the more useful signal of the two.
    expect(dropped.fidelity.volume.missingFraction).toBeGreaterThan(0);
    expect(clean.fidelity.volume.missingFraction).toBe(0);
  });
});

describe('fitting an axis of revolution', () => {
  it('ignores a handle when measuring the body', () => {
    // A mug's handle is part of the silhouette, so the row's leftmost and
    // rightmost object pixels span body, gap and handle alike: the radius came
    // out far too large and the axis was dragged sideways.
    const width = 200;
    const height = 120;
    const mask = new Uint8Array(width * height);
    const bodyX0 = 40;
    const bodyX1 = 100; // body spans 40..99, so the axis is at 70
    for (let y = 20; y < 100; y++) {
      for (let x = bodyX0; x < bodyX1; x++) mask[y * width + x] = 1;
      // A detached handle to the right, with a clear gap.
      if (y > 40 && y < 80) for (let x = 120; x < 140; x++) mask[y * width + x] = 1;
    }

    const { axis, radius } = latheProfile(mask, width, height);
    expect(axis).toBeGreaterThan(65);
    expect(axis).toBeLessThan(75);

    let widest = 0;
    for (let y = 0; y < height; y++) widest = Math.max(widest, radius[y]);
    // The body's true half-width is 30. The naive extent would have said 50.
    expect(widest).toBeGreaterThan(27);
    expect(widest).toBeLessThan(33);
  });
});

describe('choosing the palette', () => {
  it('does not spend the budget on colours no cluster asked for', () => {
    // Snapping cluster centres onto LEGO colours under a distinctness
    // constraint pushed the second cluster that wanted White onto whatever was
    // next, which is how a white mug came out in two greys.
    const samples: number[] = [];
    for (let i = 0; i < 400; i++) {
      const lab = rgbToLab(250 - (i % 12), 250 - (i % 9), 248 - (i % 7));
      samples.push(lab[0], lab[1], lab[2]);
    }
    const chosen = selectPalette(Float32Array.from(samples), 400, 12, 1);

    // Every colour picked has to be a colour something in the image is near.
    for (const c of chosen) {
      let best = Infinity;
      for (let i = 0; i < 400; i++) {
        best = Math.min(best, deltaE2000([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]], c.lab));
      }
      expect(best).toBeLessThan(12);
    }
    expect(chosen.length).toBeLessThan(12);
  });
});

describe('keeping the model buildable', () => {
  it('narrows a tall object rather than building a metre of it', () => {
    // The width control sets the width and the height follows from the
    // object's proportions, which is fine until someone photographs a bottle:
    // 32 studs wide made the test bottle 72cm tall and 3678 parts.
    const width = 200;
    const height = 400;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    const mask = new Uint8Array(width * height);
    // Roughly a bottle: five times as tall as it is wide.
    for (let y = 30; y < 330; y++)
      for (let x = 70; x < 130; x++) mask[y * width + x] = 1;

    const result = generateModel([{ rgba, mask, width, height, azimuth: 0 }], {
      ...DEFAULT_OPTIONS,
      studsWide: 32,
    });

    expect(result.sizeLimited).not.toBeNull();
    expect(result.sizeLimited!.requested).toBe(32);
    expect(result.sizeLimited!.used).toBeLessThan(32);
    expect(result.gridY).toBeLessThanOrEqual(120);
    expect(result.dimensionsMM.height).toBeLessThan(400);
  });

  it('leaves a normally proportioned object at the width asked for', () => {
    const width = 200;
    const height = 200;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    const mask = new Uint8Array(width * height);
    for (let y = 40; y < 160; y++)
      for (let x = 40; x < 160; x++) mask[y * width + x] = 1;

    const result = generateModel([{ rgba, mask, width, height, azimuth: 0 }], {
      ...DEFAULT_OPTIONS,
      studsWide: 24,
    });
    expect(result.sizeLimited).toBeNull();
    expect(result.gridX).toBe(24);
  });

  it('grows the steps rather than the manual once a build gets big', () => {
    const placements: Placement[] = [];
    for (let y = 0; y < 60; y += 3)
      for (let z = 0; z < 20; z++)
        for (let x = 0; x < 20; x += 2)
          placements.push({
            partId: 'brick-2x1',
            code: '3004',
            w: 2,
            d: 1,
            height: 3,
            x,
            y,
            z,
            color: 15,
          });

    const steps = buildSteps(placements, 8);
    expect(placements.length).toBeGreaterThan(3000);
    // Bottom-up ordering still forces one step boundary per occupied layer.
    expect(steps.length).toBeLessThan(150);
    expect(steps.reduce((n, s) => n + s.placements.length, 0)).toBe(placements.length);
    // Nothing may be asked for before the layer beneath it is finished.
    let lastY = -1;
    for (const step of steps) {
      const y = step.placements[0].y;
      expect(y).toBeGreaterThanOrEqual(lastY);
      lastY = y;
    }
  });
});

describe('revolve mode', () => {
  it('builds the handle a lathe cannot reach', () => {
    // A body of revolution cannot describe a handle. Dropping it is worse than
    // the old bug that fattened the whole mug to swallow it: a mug without its
    // handle is not a mug. The lathe fills the body and the silhouette fills
    // the rest.
    const width = 200;
    const height = 160;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 230;
      rgba[i * 4 + 1] = 230;
      rgba[i * 4 + 2] = 230;
      rgba[i * 4 + 3] = 255;
    }
    // Body 40..100, detached handle 120..140.
    for (let y = 30; y < 130; y++) {
      for (let x = 40; x < 100; x++) mask[y * width + x] = 1;
      if (y > 55 && y < 105) for (let x = 120; x < 140; x++) mask[y * width + x] = 1;
    }

    const result = generateModel([{ rgba, mask, width, height, azimuth: 0 }], {
      ...DEFAULT_OPTIONS,
      studsWide: 24,
      solidMode: 'revolve',
    });

    // The handle sits well to the right of the body, so the model has to reach
    // beyond the body's own radius.
    const rightmost = result.placements.reduce((m, p) => Math.max(m, p.x + p.w), 0);
    expect(rightmost).toBeGreaterThan(result.gridX * 0.7);
    expect(result.fidelity.silhouetteIoU).toBeGreaterThan(0.85);
  });
});

describe('the things you take away with you', () => {
  const width = 120;
  const height = 120;
  const { rgba } = makeTestImage(width, height);
  const mask = discMask(width, height);
  const result = generateModel([{ rgba, mask, width, height, azimuth: 0 }], {
    ...DEFAULT_OPTIONS,
    studsWide: 16,
    seed: 7,
  });

  it('writes a printable manual covering every step', () => {
    const html = toPrintableManual(result, 'Test model');
    expect(html).toContain('Test model');
    const headings = html.match(/<h2>Step \d+/g) ?? [];
    expect(headings.length).toBe(result.steps.length);
    // Every part in the build has to appear in some step of the manual.
    const inSteps = result.steps.reduce((n, s) => n + s.placements.length, 0);
    expect(inSteps).toBe(result.totalParts);
  });

  it('writes a Bricklink wanted list that adds up to the build', () => {
    const xml = partsListToBricklinkXml(result.partsList);
    const items = xml.match(/<ITEM>/g) ?? [];
    expect(items.length).toBe(result.partsList.length);

    const quantities = [...xml.matchAll(/<MINQTY>(\d+)<\/MINQTY>/g)].map((m) => Number(m[1]));
    expect(quantities.reduce((a, b) => a + b, 0)).toBe(result.totalParts);

    // Every line needs a real Bricklink colour and a real element number: an
    // entry Bricklink cannot resolve makes the whole upload fail.
    const colours = [...xml.matchAll(/<COLOR>(-?\d+)<\/COLOR>/g)].map((m) => Number(m[1]));
    expect(colours.length).toBe(result.partsList.length);
    for (const c of colours) expect(c).toBeGreaterThan(0);
    for (const id of [...xml.matchAll(/<ITEMID>([^<]+)<\/ITEMID>/g)].map((m) => m[1])) {
      expect(id).toMatch(/^\d+$/);
    }
  });

  it('writes a CSV with one line per colour and part', () => {
    const csv = partsListToCsv(result.partsList);
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(result.partsList.length + 1);
  });
});

describe('the running bond', () => {
  it('buys its bond by spanning joints, not by shrinking the parts', () => {
    // The score used to punish a part for reproducing a joint below without
    // ever rewarding it for spanning one, so the cheapest way to score well
    // was to place parts with as little boundary as possible. The tiler bought
    // its bond by fragmenting the model, which is the opposite of what a
    // running bond is for: across the corpus that cost 31% of the part count
    // and 2.5x the 1x1 bricks against no bond at all.
    const grid = new VoxelGrid(16, 6, 16);
    for (let y = 0; y < 6; y++)
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) grid.set(x, y, z, 0);

    const result = tileGrid(grid, new Uint8Array(grid.cells.length), [{ ldraw: 15 }], {
      useBricks: true,
      restarts: 3,
      seed: 1,
    });

    const meanArea =
      result.placements.reduce((n, p) => n + p.w * p.d, 0) / result.placements.length;
    const ones = result.placements.filter((p) => p.w === 1 && p.d === 1).length;

    // A solid block has no excuse for small parts.
    expect(meanArea).toBeGreaterThan(8);
    expect(ones).toBe(0);
    // And it still has to be bonded: joints must not stack up course on course.
    expect(result.seamAlignment).toBeLessThan(0.25);
  });

  it('keeps whole models in one piece at the shipped weights', () => {
    // The weights sit on a measured trade-off, so the thing to guard is the
    // property they were chosen for: every model one connected assembly.
    const solid = SOLIDS.find((s) => s.name === 'mug')!;
    const result = generateModel([renderView(solid, 0, 200)], {
      ...DEFAULT_OPTIONS,
      studsWide: 20,
    });
    expect(result.stability.assemblies).toBe(1);
    expect(result.stability.grounded).toBe(true);
    expect(result.stability.seamAlignment).toBeLessThan(0.35);
    expect(result.stability.score).toBeGreaterThanOrEqual(95);
  });
});

describe('when the photos disagree', () => {
  it('names the photo whose cut-out deleted the model', () => {
    // A visual hull is an intersection, so one bad outline removes material
    // every other photograph agreed was there. The model comes back mostly
    // missing, and without this there is nothing pointing at the photo
    // responsible — which is exactly what happened driving four renders of a
    // chair through the app: one cut-out kept only the seat, and the build
    // collapsed to three parts at 4% silhouette match with no explanation.
    const width = 160;
    const height = 160;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(200);

    const full = new Uint8Array(width * height);
    for (let y = 30; y < 130; y++) for (let x = 40; x < 120; x++) full[y * width + x] = 1;
    // The third photo's cut-out keeps only part of the object's width. It has
    // to stay full height: every view is scaled to a common object height, so a
    // vertically clipped mask is stretched back up rather than vetoing anything.
    const clipped = new Uint8Array(width * height);
    for (let y = 30; y < 130; y++) for (let x = 40; x < 70; x++) clipped[y * width + x] = 1;

    const view = (mask: Uint8Array, azimuth: number) => ({ rgba, mask, width, height, azimuth });
    const good = generateModel(
      [view(full, 0), view(full, 90), view(full, 45)],
      { ...DEFAULT_OPTIONS, studsWide: 16 },
    );
    expect(good.viewConflict).toBeNull();

    const bad = generateModel(
      [view(full, 0), view(full, 90), view(clipped, 45)],
      { ...DEFAULT_OPTIONS, studsWide: 16 },
    );
    expect(bad.viewConflict).not.toBeNull();
    expect(bad.viewConflict!.view).toBe(2);
    expect(bad.viewConflict!.sharePercent).toBeGreaterThan(60);
  });
});

describe('the report describes the parts, not the grid they came from', () => {
  // A 6x3x6 block, fully intended, with a palette of one colour.
  const makeInput = (covered: number) => {
    const grid = new VoxelGrid(6, 3, 6);
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) grid.set(x, y, z, 0);
    const n = grid.sx * grid.sy;
    // `covered` 2x1x2 parts, laid along the bottom course, cover 4 cells each.
    const placements = [];
    let placed = 0;
    for (let z = 0; z < 6 && placed < covered; z += 2)
      for (let x = 0; x < 6 && placed < covered; x += 2, placed++)
        placements.push({
          partId: 'plate-2x2', code: '3022', w: 2, d: 2, height: 1 as const,
          x, y: 0, z, color: 0,
        });
    return {
      grid,
      supportMask: new Uint8Array(grid.cells.length),
      placements,
      frontMask: new Uint8Array(n).fill(1),
      frontColor: new Int16Array(n).fill(0),
      frontLab: new Float32Array(n * 3),
      silhouetteTotal: n,
      palette: [{ rgb: [200, 0, 0] as [number, number, number], lab: [50, 60, 40] as [number, number, number] }],
      meanDeltaEFromPalette: 0,
    };
  };

  it('counts the volume the parts fail to deliver', () => {
    // This is the defect that let a frame tiling down to one brick report a
    // perfect silhouette: the score was taken from the grid, so nothing the
    // tiler did to the grid was ever looked at.
    const full = measureFidelity(makeInput(9));
    expect(full.volume.built).toBe(36);
    expect(full.volume.missingFraction).toBeCloseTo((108 - 36) / 108, 5);

    const sparse = measureFidelity(makeInput(1));
    expect(sparse.volume.built).toBe(4);
    expect(sparse.volume.missing).toBeGreaterThan(full.volume.missing);
  });

  it('withholds the score when most of the shape was thrown away', () => {
    const sparse = measureFidelity(makeInput(1));
    expect(sparse.volume.missingFraction).toBeGreaterThan(MAX_MISSING_FRACTION);
    expect(sparse.measured).toBe(false);
    expect(sparse.issues.join(' ')).toContain('deleted');
  });

  it('refuses an empty model rather than scoring it', () => {
    expect(() => assertObjectFound(new VoxelGrid(4, 4, 4))).toThrow(/No object found/);
    const solid = new VoxelGrid(2, 2, 2);
    solid.set(0, 0, 0, 0);
    expect(() => assertObjectFound(solid)).not.toThrow();
  });
});
