/**
 * How close is the model **the user actually receives** to the photo?
 *
 * The emphasis is the whole point. Fidelity used to be measured on the voxel
 * grid — the volume the tiler was handed — so everything the tiler,
 * `repairAssemblies` and `addSupports` did afterwards was invisible to the
 * number the UI printed. A 2000x200 frame produced a model consisting of one
 * 1x16 brick and the app reported a 100% silhouette match, 100/100 stability
 * and "one connected piece", because the grid it measured still had all 96 of
 * its voxels. Every number in here is therefore taken from `placements`: the
 * parts that end up in the box.
 *
 * Three things are kept apart on purpose:
 *
 *   - the **object** — parts standing where the photograph said there was
 *     material;
 *   - the **scaffolding** — struts invented to hold the object up. They were
 *     never in the photograph, they are painted to disappear into the model,
 *     and scoring them as fidelity is scoring the app on material it made up;
 *   - the **shortfall** — volume the grid asked for that no part covers,
 *     because repair deleted it. That is the number that decides whether the
 *     rest of this report may be believed at all.
 *
 * The silhouette is still compared against the one photograph, because that is
 * the only outline anyone gave us. What it is *not* allowed to be is the only
 * number: an extrusion matches the view it was extruded from by construction,
 * so the front IoU is the one measurement this pipeline cannot fail. Alongside
 * it the report says, per axis, how much of the intended volume the parts
 * actually deliver — which is a question the front view cannot answer.
 */

import { COLOR_BY_LDRAW, deltaE2000 } from '../lego/colors';
import { EMPTY, VoxelGrid } from '../voxel/grid';
import type { FidelityReport, Placement } from '../../types';

export interface FidelityInput {
  /** The volume the tiler was asked to build: after cleanup, hollowing and grounding. */
  grid: VoxelGrid;
  /** Cells of `grid` that are scaffolding rather than object, indexed like `grid.cells`. */
  supportMask: Uint8Array;
  /** The parts the user gets — after `repairAssemblies` and after `addSupports`. */
  placements: Placement[];
  /** The photo's silhouette on the grid's (x, y) plane, cropped to `grid`. */
  frontMask: Uint8Array;
  /** Palette index the photo asked for per column, `EMPTY` where the column is empty. */
  frontColor: Int16Array;
  /** The Lab the voxeliser sampled per column, three floats each. */
  frontLab: Float32Array;
  /**
   * Silhouette area over the *untrimmed* grid, so material the model dropped
   * entirely still counts against it rather than falling outside the window.
   */
  silhouetteTotal: number;
  palette: readonly { rgb: [number, number, number]; lab: [number, number, number] }[];
  /** Palette-reduction error, reported when nothing comparable was built. */
  meanDeltaEFromPalette: number;
}

/**
 * How much of the intended volume may go missing before the numbers stop
 * describing the model.
 *
 * Two percent is the acceptance bar's figure and it is deliberately tight: on
 * the corpus, grid volume and part volume agree to within a rounding error, so
 * anything above this is not tiling slack, it is a piece of the object being
 * deleted. Above it the report refuses to quote a silhouette score at all,
 * because a score is a claim about a model and at that point there is a
 * different model.
 */
export const MAX_MISSING_FRACTION = 0.02;

/** Grey used in the preview for a column where all you would see is a strut. */
const SCAFFOLD_INK: [number, number, number] = [150, 152, 156];

/**
 * Refuse to hand back a model that is not a model.
 *
 * The multi-view path already throws when the carve finds nothing; the
 * single-photo path used to sail on and produce a 1x1x1 empty grid, zero
 * parts, zero steps — and a report claiming 100/100 stability over it. An
 * empty cut-out is a failure with an obvious cause and an obvious remedy, and
 * both are more use than a manual for nothing.
 */
export function assertObjectFound(grid: VoxelGrid): void {
  if (grid.count() === 0) {
    throw new Error(
      'No object found in the photo — the cut-out is empty. Draw a box around the object, or paint over it with the keep brush.',
    );
  }
}

/** Occupancy and colour of every cell some part covers. */
function partOccupancy(placements: Placement[], grid: VoxelGrid) {
  const covered = new Uint8Array(grid.cells.length);
  const colorAt = new Int16Array(grid.cells.length).fill(EMPTY);
  for (const p of placements) {
    for (let dy = 0; dy < p.height; dy++) {
      const y = p.y + dy;
      if (y < 0 || y >= grid.sy) continue;
      for (let dz = 0; dz < p.d; dz++) {
        const z = p.z + dz;
        if (z < 0 || z >= grid.sz) continue;
        for (let dx = 0; dx < p.w; dx++) {
          const x = p.x + dx;
          if (x < 0 || x >= grid.sx) continue;
          const i = grid.index(x, y, z);
          covered[i] = 1;
          colorAt[i] = p.color;
        }
      }
    }
  }
  return { covered, colorAt };
}

/** Intersection-over-union of two equally sized binary planes. */
function iou(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) either++;
    if (a[i] && b[i]) both++;
  }
  return either > 0 ? both / either : 1;
}

/** Flatten a volume along one axis. `front` drops z, `side` drops x, `top` drops y. */
function project(cells: Uint8Array, grid: VoxelGrid, axis: 'front' | 'side' | 'top'): Uint8Array {
  const { sx, sy, sz } = grid;
  const out = new Uint8Array(
    axis === 'front' ? sx * sy : axis === 'side' ? sz * sy : sx * sz,
  );
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (!cells[grid.index(x, y, z)]) continue;
        if (axis === 'front') out[y * sx + x] = 1;
        else if (axis === 'side') out[y * sz + z] = 1;
        else out[z * sx + x] = 1;
      }
    }
  }
  return out;
}

/**
 * Measure the finished model.
 *
 * Everything is classified per cell rather than per part, because
 * `repairAssemblies` re-cuts runs and a merge of an object part with a strut
 * inherits neither's flag cleanly. A cell is object material if the grid asked
 * for object there and a part covers it; it is scaffolding if a part covers it
 * and the grid did not ask for the object there — whether that strut came from
 * `groundComponents` before the tiler ran or from `addSupports` after it.
 */
export function measureFidelity(input: FidelityInput): FidelityReport {
  const { grid, supportMask, placements, frontMask, frontColor, frontLab, palette } = input;
  const { sx, sy } = grid;
  const { covered, colorAt } = partOccupancy(placements, grid);

  const objectCells = new Uint8Array(grid.cells.length);
  const scaffoldCells = new Uint8Array(grid.cells.length);
  let intendedVolume = 0;
  let builtVolume = 0;
  let missingVolume = 0;
  let scaffoldVolume = 0;
  for (let i = 0; i < grid.cells.length; i++) {
    const intended = grid.cells[i] !== EMPTY && !supportMask[i];
    if (intended) intendedVolume++;
    if (covered[i]) {
      if (intended) {
        objectCells[i] = 1;
        builtVolume++;
      } else {
        scaffoldCells[i] = 1;
        scaffoldVolume++;
      }
    } else if (intended) {
      missingVolume++;
    }
  }
  const missingFraction = intendedVolume > 0 ? missingVolume / intendedVolume : 1;

  // Front projection of the object — scaffolding excluded, because a silhouette
  // filled in by a strut is a silhouette the object did not have.
  const projected = project(objectCells, grid, 'front');
  let intersection = 0;
  let modelArea = 0;
  for (let i = 0; i < projected.length; i++) {
    if (projected[i]) modelArea++;
    if (projected[i] && frontMask[i]) intersection++;
  }
  // Silhouette pixels outside the crop are, by construction, ones the model has
  // nothing at: they belong in the union and never in the intersection.
  const union = input.silhouetteTotal + modelArea - intersection;

  // What the parts deliver against what the grid asked for, from three sides.
  // The front number would be 1.0 for any model the tiler covered completely,
  // which is the point: when it is not 1.0 something was thrown away, and the
  // side and top say whether it was thrown away somewhere the photo can see.
  const intendedCells = new Uint8Array(grid.cells.length);
  for (let i = 0; i < grid.cells.length; i++) {
    if (grid.cells[i] !== EMPTY && !supportMask[i]) intendedCells[i] = 1;
  }
  const agreement = {
    front: iou(project(objectCells, grid, 'front'), project(intendedCells, grid, 'front')),
    side: iou(project(objectCells, grid, 'side'), project(intendedCells, grid, 'side')),
    top: iou(project(objectCells, grid, 'top'), project(intendedCells, grid, 'top')),
  };

  // Colour error and preview, both taken from the part that is actually facing
  // the camera rather than from the colour the column asked for.
  const preview = new Uint8ClampedArray(sx * sy * 4);
  let deltaSum = 0;
  let deltaCount = 0;
  for (let y = 0; y < sy; y++) {
    for (let x = 0; x < sx; x++) {
      const i = y * sx + x;
      // Preview rows run top-down like an image, grid rows run bottom-up.
      const o = ((sy - 1 - y) * sx + x) * 4;

      let ldraw = EMPTY;
      let scaffold = false;
      for (let z = 0; z < grid.sz; z++) {
        const c = grid.index(x, y, z);
        if (objectCells[c]) {
          ldraw = colorAt[c];
          break;
        }
        if (scaffoldCells[c] && !scaffold) {
          scaffold = true;
          ldraw = colorAt[c];
        }
      }

      if (ldraw === EMPTY) {
        preview[o + 3] = 0;
        continue;
      }
      const color = COLOR_BY_LDRAW.get(ldraw);
      // Struts are drawn in a flat grey rather than the colour they were
      // painted to hide behind. This picture is the one the user holds up
      // against their photo; scaffolding showing through as scaffolding is the
      // difference between a comparison and a trick.
      const rgb = scaffold ? SCAFFOLD_INK : color?.rgb ?? [128, 128, 128];
      preview[o] = rgb[0];
      preview[o + 1] = rgb[1];
      preview[o + 2] = rgb[2];
      preview[o + 3] = 255;

      if (scaffold || !color || frontColor[i] === EMPTY) continue;
      deltaSum += deltaE2000(
        [frontLab[i * 3], frontLab[i * 3 + 1], frontLab[i * 3 + 2]],
        color.lab,
      );
      deltaCount++;
    }
  }

  let supportParts = 0;
  for (const p of placements) if (p.support) supportParts++;

  const issues: string[] = [];
  if (placements.length === 0) {
    issues.push('The build produced no parts at all.');
  } else if (missingFraction > MAX_MISSING_FRACTION) {
    issues.push(
      `${Math.round(missingFraction * 100)}% of the shape was deleted between the voxel grid and the parts, ` +
        'because it could not be made to hold together. What is left is not the object that was measured.',
    );
  }
  if (palette.length === 0) issues.push('No colours could be sampled from the photo.');

  return {
    silhouetteIoU: union > 0 ? intersection / union : 0,
    meanDeltaE: deltaCount > 0 ? deltaSum / deltaCount : input.meanDeltaEFromPalette,
    preview: { width: sx, height: sy, rgba: preview },
    volume: {
      intended: intendedVolume,
      built: builtVolume,
      missing: missingVolume,
      missingFraction,
    },
    support: {
      parts: supportParts,
      partShare: placements.length > 0 ? supportParts / placements.length : 0,
      voxels: scaffoldVolume,
      volumeShare:
        builtVolume + scaffoldVolume > 0 ? scaffoldVolume / (builtVolume + scaffoldVolume) : 0,
    },
    agreement,
    // A score is a claim about a model. When most of the model was thrown away
    // the claim is about something the user is not getting, so it is withheld
    // rather than quoted with a caveat nobody reads.
    measured: placements.length > 0 && missingFraction <= MAX_MISSING_FRACTION,
    issues,
  };
}
