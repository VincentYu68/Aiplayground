/**
 * Turning a carved visual hull into a coloured LEGO voxel grid.
 *
 * The hull already has the right shape and a colour per voxel taken from
 * whichever camera saw that surface best; all that remains is to reduce those
 * colours onto the brick palette, using the same per-course wander that keeps
 * colour boundaries from stacking into structural cracks.
 */

import { deltaE2000, PALETTE, rgbToLab, type LegoColor } from '../lego/colors';
import {
  fillUnseenColours,
  sampleHullColours,
  type HullResult,
} from '../multiview/visualHull';
import { PLATE_MM, STUD_MM } from '../lego/units';
import { selectPalette } from './quantize';
import { EMPTY, VoxelGrid } from './grid';
import type { VoxelizeResult } from './voxelize';
import { COURSE_COLOR_JITTER } from './voxelize';

/** Nearest palette colour, nudged per course. Mirrors the single-view path. */
function colorFor(
  lab: readonly number[],
  palette: readonly LegoColor[],
  course: number,
): { index: number; deltaE: number } {
  let best = 0;
  let bestScore = Infinity;
  let bestDelta = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const delta = deltaE2000(lab, palette[i].lab);
    const hash = Math.sin(course * 12.9898 + i * 78.233) * 43758.5453;
    const jitter = 1 + COURSE_COLOR_JITTER * (2 * (hash - Math.floor(hash)) - 1);
    const score = delta * jitter;
    if (score < bestScore) {
      bestScore = score;
      bestDelta = delta;
      best = i;
    }
  }
  return { index: best, deltaE: bestDelta };
}

export function voxelizeFromHull(
  hull: HullResult,
  maxColors: number,
  seed: number,
): VoxelizeResult {
  const { occupancy, sx, sy, sz } = hull;

  const { rgb, coloured } = sampleHullColours(hull);
  fillUnseenColours(hull, rgb, coloured);

  // Choose the palette from the surface colours only: the interior is filled
  // by diffusion and would otherwise vote several times for the same hue.
  const surface = new Float32Array(sx * sy * sz * 3);
  let count = 0;
  for (let gy = 0; gy < sy; gy++) {
    for (let gz = 0; gz < sz; gz++) {
      for (let gx = 0; gx < sx; gx++) {
        const i = (gy * sz + gz) * sx + gx;
        if (!occupancy[i]) continue;
        const exposed =
          gx === 0 ||
          gy === 0 ||
          gz === 0 ||
          gx === sx - 1 ||
          gy === sy - 1 ||
          gz === sz - 1 ||
          !occupancy[i - 1] ||
          !occupancy[i + 1] ||
          !occupancy[i - sx] ||
          !occupancy[i + sx] ||
          !occupancy[i - sx * sz] ||
          !occupancy[i + sx * sz];
        if (!exposed) continue;
        const [l, a, b] = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        surface[count * 3] = l;
        surface[count * 3 + 1] = a;
        surface[count * 3 + 2] = b;
        count++;
      }
    }
  }
  const palette = count > 0 ? selectPalette(surface, count, maxColors, seed) : [PALETTE[0]];

  const grid = new VoxelGrid(sx, sy, sz);
  let deltaSum = 0;
  let deltaCount = 0;
  for (let gy = 0; gy < sy; gy++) {
    const course = Math.floor(gy / 3);
    for (let gz = 0; gz < sz; gz++) {
      for (let gx = 0; gx < sx; gx++) {
        const i = (gy * sz + gz) * sx + gx;
        if (!occupancy[i]) continue;
        const { index, deltaE } = colorFor(
          rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]),
          palette,
          course,
        );
        grid.set(gx, gy, gz, index);
        deltaSum += deltaE;
        deltaCount++;
      }
    }
  }

  // Fidelity is judged against the view the user framed: view 0.
  const view = hull.views[0];
  const unitsPerPlate = hull.unitsPerStud * (PLATE_MM / STUD_MM);
  const frontMask = new Uint8Array(sx * sy);
  const frontColor = new Int16Array(sx * sy).fill(EMPTY);
  const frontLab = new Float32Array(sx * sy * 3);
  for (let gy = 0; gy < sy; gy++) {
    const y = (gy + 0.5) * unitsPerPlate;
    const py = Math.round(view.bottomY - y * view.pixelsPerUnit);
    for (let gx = 0; gx < sx; gx++) {
      const x = -hull.extent + (gx + 0.5) * hull.unitsPerStud;
      // Angles are relative to view 0, so its horizontal axis is exactly x.
      const px = Math.round(view.centreX + x * view.pixelsPerUnit);
      const idx = gy * sx + gx;
      if (px >= 0 && py >= 0 && px < view.width && py < view.height) {
        frontMask[idx] = view.mask[py * view.width + px] ? 1 : 0;
      }
      // Colour of the frontmost voxel in this column, for the comparison strip,
      // kept next to the hull colour it was reduced from so fidelity can be
      // scored without mapping grid coordinates back into the photo.
      for (let gz = 0; gz < sz; gz++) {
        const v = grid.get(gx, gy, gz);
        if (v !== EMPTY) {
          frontColor[idx] = v;
          const i = (gy * sz + gz) * sx + gx;
          const lab = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
          frontLab[idx * 3] = lab[0];
          frontLab[idx * 3 + 1] = lab[1];
          frontLab[idx * 3 + 2] = lab[2];
          break;
        }
      }
    }
  }

  return {
    grid,
    palette,
    frontMask,
    frontColor,
    frontLab,
    meanDeltaE: deltaCount ? deltaSum / deltaCount : 0,
  };
}

export const HULL_STUD_MM = STUD_MM;
