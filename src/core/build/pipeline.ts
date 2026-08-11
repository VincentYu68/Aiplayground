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
import { modelDimensionsMM, platesForAspect } from '../lego/units';
import { bounds } from '../image/raster';
import { deltaE2000 } from '../lego/colors';
import type { BuildOptions, BuildResult, FidelityReport } from '../../types';

export type ProgressFn = (stage: string, fraction: number) => void;

/** Wall thickness left behind when the interior is carved out: two studs. */
const SHELL_MM = 16;

/**
 * Tallest model worth building: 40 courses, a little under 39cm.
 *
 * The width control sets the width, and the height follows from the object's
 * proportions — which is fine until someone photographs a bottle. At the
 * default 32 studs the test bottle came out 225 plates tall: 72cm, 3678 parts
 * and 489 steps, from a setting that produces a sensible model for anything
 * roughly as tall as it is wide. Nobody chose that, and nothing in the UI
 * warned about it. So the width is reduced until the model fits, and the
 * report says it happened.
 */
const MAX_PLATES = 120;

/**
 * Reduce the width until the model's height is buildable.
 *
 * Both paths derive height from the width and the object's proportions, so
 * this only has to be decided once, from the view the user framed.
 */
function fitToBuildableHeight(
  views: View[],
  options: BuildOptions,
): { options: BuildOptions; requestedStudsWide: number | null } {
  const box = bounds(views[0].mask, views[0].width, views[0].height);
  if (!box) return { options, requestedStudsWide: null };
  const plates = platesForAspect(options.studsWide, box.width, box.height);
  if (plates <= MAX_PLATES) return { options, requestedStudsWide: null };

  // Six studs is the floor: below that there is not enough width left to carry
  // any of the object's shape. Something as extreme as a pencil therefore ends
  // up over the cap, which is the right way round — it is better to be a little
  // too tall than to be four studs of nothing.
  const scaled = Math.max(6, Math.floor(options.studsWide * (MAX_PLATES / plates)));
  if (scaled >= options.studsWide) return { options, requestedStudsWide: null };
  return {
    options: { ...options, studsWide: scaled },
    requestedStudsWide: options.studsWide,
  };
}

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
  requestedOptions: BuildOptions,
  onProgress: ProgressFn = () => {},
): BuildResult {
  const started = Date.now();
  const primary = views[0];
  const multiView = views.length >= 2;
  const { options, requestedStudsWide } = fitToBuildableHeight(views, requestedOptions);

  let voxelResult;
  let viewConflict: BuildResult['viewConflict'] = null;
  if (multiView) {
    onProgress('Carving the shape from the silhouettes', 0.1);
    const hull = carveVisualHull(views, {
      studsWide: options.studsWide,
      tolerance: options.hullTolerance,
    });
    if (!hull) throw new Error('No object found in the photos');
    // One photo removing far more than its share of the material that every
    // other photo agreed on means its cut-out is wrong, not that the object is
    // that shape.
    const totalVetoes = hull.vetoes.reduce((a, b) => a + b, 0);
    if (totalVetoes > 0) {
      let worst = 0;
      for (let i = 1; i < hull.vetoes.length; i++) {
        if (hull.vetoes[i] > hull.vetoes[worst]) worst = i;
      }
      const share = hull.vetoes[worst] / totalVetoes;
      const evenShare = 1 / hull.vetoes.length;
      if (hull.vetoes.length > 1 && share > Math.max(0.6, evenShare * 2)) {
        viewConflict = { view: worst, sharePercent: Math.round(share * 100) };
      }
    }
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
  // The silhouette has to be counted *before* the crop. Cropping it to the
  // model's own extent hides exactly the failure worth knowing about: anything
  // the model dropped entirely — a mug's handle, once revolve mode stopped
  // pretending the handle was part of the body — falls outside the window and
  // stops being counted as missing at all.
  let silhouetteTotal = 0;
  for (let i = 0; i < voxelResult.frontMask.length; i++) {
    if (voxelResult.frontMask[i]) silhouetteTotal++;
  }
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
  const frontLab = cropLabPlane(
    voxelResult.frontLab,
    voxelResult.grid.sx,
    grid.sx,
    grid.sy,
    trim.offsetX,
    trim.offsetY,
  );

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
    frontLab,
    silhouetteTotal,
    voxelResult.palette,
    voxelResult.meanDeltaE,
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
    viewConflict,
    sizeLimited:
      requestedStudsWide === null
        ? null
        : { requested: requestedStudsWide, used: options.studsWide },
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

/** Crop a three-channel (x, y) plane to match a trimmed grid. */
function cropLabPlane(
  source: Float32Array,
  sourceWidth: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): Float32Array {
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = ((y + offsetY) * sourceWidth + (x + offsetX)) * 3;
      const d = (y * width + x) * 3;
      out[d] = source[s];
      out[d + 1] = source[s + 1];
      out[d + 2] = source[s + 2];
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
 *
 * The colour comparison uses the Lab value the voxeliser sampled for each
 * column, not a fresh lookup into the photo. Re-deriving it meant mapping grid
 * columns across the whole image while the grid had been sampled across the
 * object's bounding box, so any photo with margin around the object was scored
 * against the wrong pixels — and it was scored against the colour the column
 * *wanted*, not the colour the finished model ended up with there.
 */
function measureFidelity(
  grid: VoxelGrid,
  frontMask: Uint8Array,
  frontColor: Int16Array,
  frontLab: Float32Array,
  /** Silhouette area over the *untrimmed* grid, so material the model dropped still counts. */
  silhouetteTotal: number,
  palette: { rgb: [number, number, number]; lab: [number, number, number] }[],
  meanDeltaEFromPalette: number,
): FidelityReport {
  const { sx, sy } = grid;

  // Front projection of what actually got built.
  const projected = new Uint8Array(sx * sy);
  const builtColor = new Int16Array(sx * sy).fill(EMPTY);
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
      builtColor[i] = colorIndex;
      const rgb = palette[colorIndex]?.rgb ?? [128, 128, 128];
      preview[o] = rgb[0];
      preview[o + 1] = rgb[1];
      preview[o + 2] = rgb[2];
      preview[o + 3] = 255;
    }
  }

  let intersection = 0;
  let modelArea = 0;
  for (let i = 0; i < projected.length; i++) {
    if (projected[i]) modelArea++;
    if (projected[i] && frontMask[i]) intersection++;
  }
  // Silhouette pixels outside the crop are, by construction, ones the model has
  // nothing at: they belong in the union and never in the intersection.
  const union = silhouetteTotal + modelArea - intersection;

  // Colour error against the source, measured where the model has material.
  let deltaSum = 0;
  let deltaCount = 0;
  for (let i = 0; i < projected.length; i++) {
    // Only columns that both photographed as object and got built are
    // comparable: elsewhere there is no pair of colours to take a distance
    // between.
    if (!projected[i] || frontColor[i] === EMPTY) continue;
    const built = palette[builtColor[i]];
    if (!built) continue;
    const lab: [number, number, number] = [frontLab[i * 3], frontLab[i * 3 + 1], frontLab[i * 3 + 2]];
    deltaSum += deltaE2000(lab, built.lab);
    deltaCount++;
  }

  return {
    silhouetteIoU: union > 0 ? intersection / union : 0,
    meanDeltaE: deltaCount > 0 ? deltaSum / deltaCount : meanDeltaEFromPalette,
    preview: { width: sx, height: sy, rgba: preview },
  };
}
