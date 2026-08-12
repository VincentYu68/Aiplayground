/**
 * The whole photo -> manual pipeline, in one place.
 *
 * Deliberately pure and synchronous: no DOM, no canvas, no network. That makes
 * it runnable in a worker, testable in node, and reproducible for a given seed.
 */

import { depthFieldFromRelief, estimateDepth, measureRelief } from '../image/depth';
import { planGrid, snapToCourses, voxelize, type GridPlanOptions } from '../voxel/voxelize';
import { voxelizeFromHull } from '../voxel/fromHull';
import { carveVisualHull, type View } from '../multiview/visualHull';
import { groundComponents, hollow, removeSmallComponents, shouldHollow } from '../voxel/cleanup';
import { EMPTY, VoxelGrid } from '../voxel/grid';
import { tileGrid } from './tiling';
import { addSupports, analyseStability, repairAssemblies } from './stability';
import { buildSteps } from './steps';
import { assertObjectFound, measureFidelity } from './fidelity';
import { buildPartsList, totalParts } from '../export/bom';
import { baseplateFor } from '../lego/catalog';
import { modelDimensionsMM, platesForAspect } from '../lego/units';
import { bounds } from '../image/raster';
import type { BuildOptions, BuildResult } from '../../types';

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

/** The subset of the build options that decides the lattice. */
function planOptionsFrom(options: BuildOptions): GridPlanOptions {
  return {
    studsWide: options.studsWide,
    depthScale: options.depthScale,
    solidMode: options.solidMode,
    wholeCourses: options.resolution === 'bricks',
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
    // A measured depth map when the weights are here, the invented bulge when
    // they are not. These are not two flavours of the same thing: the bulge
    // makes every object an inflated copy of its own outline, and the whole
    // reason single-photo models used to read as a loaf. Shading is only
    // consulted in the fallback, where it is the sole source of relief; against
    // a real depth map it adds nothing but luminance noise.
    onProgress(primary.relief ? 'Reading the depth map' : 'Estimating depth', 0.05);
    let depth;
    if (primary.relief) {
      const measured = measureRelief(
        primary.relief,
        primary.mask,
        primary.width,
        primary.height,
      );
      // How deep the model will be has to be settled before the volume can be
      // closed, because the surface rolls over the silhouette edge across a
      // distance equal to the object's half-depth — not across some fraction of
      // how big the silhouette happens to be.
      const plan = planGrid(
        primary.mask,
        primary.width,
        primary.height,
        planOptionsFrom(options),
        measured.reliefScale,
      );
      depth = depthFieldFromRelief(measured, primary.mask, primary.width, primary.height, {
        roundness: options.roundness,
        halfDepthPx: plan ? (plan.gridZ / 2) * plan.pxPerStud : 1,
      });
    } else {
      depth = estimateDepth(primary.rgba, primary.mask, primary.width, primary.height, {
        shadingInfluence: options.shadingInfluence,
      });
    }

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

  // Checked after cleanup rather than before it, so a cut-out that survives
  // segmentation and is then eaten by the small-component pass fails here too.
  assertObjectFound(grid);

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
  // A base counts as part of the model only when it does something. With more
  // than one assembly it is what holds them in the same object, so it belongs
  // in the parts list and the export; for a single grounded piece it is display
  // furniture, and billing the user for scenery is not advice.
  const baseplate = stability.assemblies > 1 ? baseplateFor(grid.sx, grid.sz) : null;
  const partsList = buildPartsList(placements, baseplate);

  // Measured on `placements`, not on `grid`: everything the tiler, the assembly
  // repair and the support pass do happens after the grid, and measuring the
  // grid made all of it invisible. A frame that tiles down to one 1x16 brick
  // used to report a perfect silhouette over it.
  const fidelity = measureFidelity({
    grid,
    supportMask,
    placements,
    frontMask,
    frontColor,
    frontLab,
    silhouetteTotal,
    palette: voxelResult.palette,
    meanDeltaEFromPalette: voxelResult.meanDeltaE,
  });

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
    baseplate,
    dimensionsMM: modelDimensionsMM(grid.sx, grid.sy, grid.sz),
    viewsUsed: views.length,
    geometry: multiView ? 'visual-hull' : 'extruded',
    depthSource: multiView ? 'multi-view' : primary.relief ? 'measured' : 'guessed',
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

