/**
 * The whole photo -> manual pipeline, in one place.
 *
 * Deliberately pure and synchronous: no DOM, no canvas, no network. That makes
 * it runnable in a worker, testable in node, and reproducible for a given seed.
 */

import { estimateDepth } from '../image/depth';
import { snapToCourses, voxelize } from '../voxel/voxelize';
import { voxelizeFromHull } from '../voxel/fromHull';
import { carveVisualHull, type View } from '../multiview/visualHull';
import { groundComponents, hollow, removeSmallComponents, shouldHollow } from '../voxel/cleanup';
import { EMPTY, VoxelGrid } from '../voxel/grid';
import { tileGrid } from './tiling';
import { addSupports, analyseStability, repairAssemblies } from './stability';
import { buildSteps } from './steps';
import { buildPartsList, totalParts } from '../export/bom';
import { modelDimensionsMM } from '../lego/units';
import { deltaE2000, rgbToLab } from '../lego/colors';
import type { BuildOptions, BuildResult, FidelityReport } from '../../types';

export type ProgressFn = (stage: string, fraction: number) => void;

/** Wall thickness left behind when the interior is carved out: two studs. */
const SHELL_MM = 16;

/**
 * Build from one or more views.
 *
 * With two or more photographs the shape is carved as a visual hull, which is
 * real recovered geometry. With one, there is nothing to intersect, so it falls
 * back to extruding the silhouette and guessing the depth — which is why the
 * report distinguishes the two.
 */
export function generateModel(
  views: View[],
  options: BuildOptions,
  onProgress: ProgressFn = () => {},
): BuildResult {
  const started = Date.now();
  const primary = views[0];
  const multiView = views.length >= 2;

  let voxelResult;
  if (multiView) {
    onProgress('Carving the shape from the silhouettes', 0.1);
    const hull = carveVisualHull(views, {
      studsWide: options.studsWide,
      tolerance: options.hullTolerance,
    });
    if (!hull) throw new Error('No object found in the photos');
    onProgress('Colouring from the photos', 0.25);
    voxelResult = voxelizeFromHull(hull, options.maxColors, options.seed);
  } else {
    onProgress('Estimating depth', 0.05);
    const depth = estimateDepth(primary.rgba, primary.mask, primary.width, primary.height, {
      shadingInfluence: options.shadingInfluence,
    });

    onProgress('Sampling onto the stud grid', 0.2);
    voxelResult = voxelize(primary.rgba, primary.mask, primary.width, primary.height, depth, {
      studsWide: options.studsWide,
      depthScale: options.depthScale,
      solidMode: options.solidMode,
      backTreatment: options.backTreatment,
      maxColors: options.maxColors,
      wholeCourses: options.resolution === 'bricks',
      seed: options.seed,
    });
  }

  // Crop away the empty space the carve leaves around a shape that is not
  // square in plan, so the reported size is the object's rather than the grid's.
  const trim = voxelResult.grid.trimmed();
  let grid = trim.grid;
  // The fidelity masks are indexed against the untrimmed grid, so they have to
  // be cropped in step or the comparison silently comes apart.
  const frontMask = cropPlane(
    voxelResult.frontMask,
    voxelResult.grid.sx,
    grid.sx,
    grid.sy,
    trim.offsetX,
    trim.offsetY,
    0,
  );
  const frontColor = cropPlane(
    voxelResult.frontColor,
    voxelResult.grid.sx,
    grid.sx,
    grid.sy,
    trim.offsetX,
    trim.offsetY,
    EMPTY,
  ) as Int16Array;

  if (options.resolution === 'bricks') grid = snapToCourses(grid);

  onProgress('Cleaning up the volume', 0.35);
  const minVoxels = Math.max(4, Math.round(grid.count() * 0.0008));
  const { removedFragments } = removeSmallComponents(grid, minVoxels);

  if (options.hollow && shouldHollow(grid, SHELL_MM)) {
    hollow(grid, SHELL_MM, 3, options.resolution === 'bricks');
  }

  const supportMask = new Uint8Array(grid.cells.length);
  onProgress('Making everything reach the ground', 0.45);
  const groundedVoxels = groundComponents(grid, supportMask);

  onProgress('Choosing bricks', 0.6);
  const tiling = tileGrid(grid, supportMask, voxelResult.palette, {
    useBricks: true,
    restarts: gridRestarts(grid),
    seed: options.seed,
  });

  const dims = { sx: grid.sx, sy: grid.sy, sz: grid.sz };
  onProgress('Checking stability', 0.8);
  const placements = [...tiling.placements];
  const repair = repairAssemblies(placements, dims);
  const supportsAdded = addSupports(placements, dims);
  const stability = analyseStability({
    placements,
    dims,
    seamAlignment: tiling.seamAlignment,
    removedFragments: removedFragments + repair.removed,
    supportsAdded: supportsAdded + groundedVoxels,
    tiesRecoloured: repair.recoloured,
  });

  onProgress('Writing the manual', 0.9);
  const steps = buildSteps(placements, options.partsPerStep);
  const partsList = buildPartsList(placements);

  const fidelity = measureFidelity(
    grid,
    frontMask,
    frontColor,
    voxelResult.palette,
    voxelResult.meanDeltaE,
    primary.rgba,
    primary.mask,
    primary.width,
    primary.height,
  );

  onProgress('Done', 1);

  return {
    options,
    gridX: grid.sx,
    gridY: grid.sy,
    gridZ: grid.sz,
    placements,
    steps,
    stability,
    fidelity,
    partsList,
    totalParts: totalParts(partsList),
    dimensionsMM: modelDimensionsMM(grid.sx, grid.sy, grid.sz),
    viewsUsed: views.length,
    geometry: multiView ? 'visual-hull' : 'extruded',
    elapsedMs: Date.now() - started,
  };
}

/** Crop an (x, y) plane to match a trimmed grid. */
function cropPlane<T extends Uint8Array | Int16Array>(
  source: T,
  sourceWidth: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  empty: number,
): T {
  const out = new (source.constructor as new (n: number) => T)(width * height);
  if (empty !== 0) out.fill(empty as never);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = source[(y + offsetY) * sourceWidth + (x + offsetX)];
    }
  }
  return out;
}

/** Bigger models get fewer randomised restarts so generation stays interactive. */
function gridRestarts(grid: VoxelGrid): number {
  const area = grid.sx * grid.sz;
  if (area > 4000) return 2;
  if (area > 1500) return 3;
  return 5;
}

/**
 * How close is the finished model to the photo?
 *
 * Silhouette agreement is measured as intersection-over-union between the
 * model's front projection and the segmented object. Colour error is the mean
 * CIEDE2000 between each source column and the brick colour that replaced it.
 * Both are reported to the user, because "as close as possible" is a claim that
 * should come with a number attached.
 */
function measureFidelity(
  grid: VoxelGrid,
  frontMask: Uint8Array,
  frontColor: Int16Array,
  palette: { rgb: [number, number, number]; lab: [number, number, number] }[],
  meanDeltaEFromPalette: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
): FidelityReport {
  const { sx, sy } = grid;

  // Front projection of what actually got built.
  const projected = new Uint8Array(sx * sy);
  const preview = new Uint8ClampedArray(sx * sy * 4);
  for (let y = 0; y < sy; y++) {
    for (let x = 0; x < sx; x++) {
      let colorIndex = EMPTY;
      for (let z = 0; z < grid.sz; z++) {
        const v = grid.get(x, y, z);
        if (v !== EMPTY) {
          colorIndex = v;
          break;
        }
      }
      const i = y * sx + x;
      // Preview rows run top-down like an image, grid rows run bottom-up.
      const o = ((sy - 1 - y) * sx + x) * 4;
      if (colorIndex === EMPTY) {
        preview[o + 3] = 0;
        continue;
      }
      projected[i] = 1;
      const rgb = palette[colorIndex]?.rgb ?? [128, 128, 128];
      preview[o] = rgb[0];
      preview[o + 1] = rgb[1];
      preview[o + 2] = rgb[2];
      preview[o + 3] = 255;
    }
  }

  let intersection = 0;
  let union = 0;
  for (let i = 0; i < projected.length; i++) {
    const a = projected[i];
    const b = frontMask[i];
    if (a || b) union++;
    if (a && b) intersection++;
  }

  // Colour error against the source, measured where the model has material.
  let deltaSum = 0;
  let deltaCount = 0;
  if (width > 0 && height > 0) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const i = y * sx + x;
        if (!projected[i] || frontColor[i] === EMPTY) continue;
        const target = palette[frontColor[i]];
        if (!target) continue;
        const sx0 = Math.min(width - 1, Math.floor(((x + 0.5) / sx) * width));
        const sy0 = Math.min(height - 1, Math.floor(((sy - 1 - y + 0.5) / sy) * height));
        const si = sy0 * width + sx0;
        if (!mask[si]) continue;
        const lab = rgbToLab(rgba[si * 4], rgba[si * 4 + 1], rgba[si * 4 + 2]);
        deltaSum += deltaE2000(lab, target.lab);
        deltaCount++;
      }
    }
  }

  return {
    silhouetteIoU: union > 0 ? intersection / union : 0,
    meanDeltaE: deltaCount > 0 ? deltaSum / deltaCount : meanDeltaEFromPalette,
    preview: { width: sx, height: sy, rgba: preview },
  };
}
