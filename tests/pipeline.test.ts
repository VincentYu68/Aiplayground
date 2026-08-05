import { describe, expect, it } from 'vitest';
import { generateModel } from '../src/core/build/pipeline';
import { EMPTY, VoxelGrid } from '../src/core/voxel/grid';
import { hollow, labelComponents, shouldHollow } from '../src/core/voxel/cleanup';
import { tileGrid } from '../src/core/build/tiling';
import {
  addSupports,
  analyseStability,
  countAssemblies,
  repairAssemblies,
} from '../src/core/build/stability';
import { buildSteps, orderPlacements } from '../src/core/build/steps';
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
import { buildPartsList } from '../src/core/export/bom';
import { distanceTransform, fillHoles, keepLargestComponents } from '../src/core/image/raster';
import { segment } from '../src/core/image/segment';
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
    generateModel(rgba, mask, width, height, {
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
    generateModel(head.rgba, head.mask, head.width, head.height, {
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
  const result = generateModel(rgba, mask, width, height, {
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
    const again = generateModel(rgba, mask, width, height, {
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
