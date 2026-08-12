/**
 * The frame everything is measured in, and the measurements themselves.
 *
 * Two solids have to be compared: the object that was photographed, which is
 * known exactly, and the model the app built from that photograph. They arrive
 * in different coordinate systems, at different resolutions, in different units,
 * and one of them has no absolute scale at all — a single photograph cannot say
 * how big anything is. So a gauge has to be chosen, and the choice decides what
 * the benchmark is able to see.
 *
 * The gauge is the object's own height. Both solids are expressed in units where
 * they are exactly one unit tall, and neither is rescaled horizontally to fit
 * the other. That is deliberate and it is the whole point: width relative to
 * height is visible in the photograph, so getting it wrong is a real error and
 * must stay countable; depth relative to height is *not* visible in the
 * photograph, which is precisely why a pipeline that guesses it badly has to be
 * caught here rather than flattered. Normalising each axis separately — the
 * obvious way to make numbers look better — would erase both.
 *
 * Registration is searched over a few cells of translation, because a model
 * that is one stud off centre is not a model of the wrong shape. Scale is not
 * searched. Rotation is not searched.
 */

import { PLATE_MM, STUD_MM } from '../../src/core/lego/units';
import type { BuildResult } from '../../src/types';
import { insideParts, partsBounds, type Part } from './parts';

/** Cells per object height. 64 puts a 32-stud model at about two cells a stud. */
export const RES = 64;

/** How far the model may be shifted to find its best registration, in cells. */
const SEARCH_XZ = 3;
const SEARCH_Y = 2;

export interface Lattice {
  nx: number;
  ny: number;
  nz: number;
  /** Size of one cell, in object heights. */
  cell: number;
  /** Centre of cell (0,0,0), in the camera frame. */
  originX: number;
  originY: number;
  originZ: number;
}

export interface Occupancy {
  lattice: Lattice;
  /** Indexed [(y * nz + z) * nx + x]. */
  cells: Uint8Array;
  count: number;
}

function index(lattice: Lattice, x: number, y: number, z: number): number {
  return (y * lattice.nz + z) * lattice.nx + x;
}

export function makeLattice(halfX: number, halfZ: number, top = 1): Lattice {
  const cell = 1 / RES;
  const nx = Math.max(1, Math.ceil((halfX * 2) / cell));
  const nz = Math.max(1, Math.ceil((halfZ * 2) / cell));
  const ny = Math.max(1, Math.ceil(top / cell));
  return {
    nx,
    ny,
    nz,
    cell,
    originX: -((nx - 1) / 2) * cell,
    originY: cell / 2,
    originZ: -((nz - 1) / 2) * cell,
  };
}

/**
 * The photographed object, voxelised in the camera's own frame.
 *
 * The camera's right-hand axis becomes x and its view direction becomes z,
 * which is the frame `voxelize.ts` builds its grid in — "z counts back from the
 * camera", so a model and the solid that posed for it are directly comparable
 * once both are put here.
 */
export function truthOccupancy(parts: Part[], azimuthDeg: number, lattice: Lattice): Occupancy {
  const a = (azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  // Camera frame back to world: x_world = u·cos + w·sin, z_world = u·sin − w·cos,
  // the inverse of u = x·cos + z·sin, w = x·sin − z·cos.
  const cells = new Uint8Array(lattice.nx * lattice.ny * lattice.nz);
  let count = 0;
  const centre = footprintCentre(parts, azimuthDeg);
  for (let iy = 0; iy < lattice.ny; iy++) {
    const y = lattice.originY + iy * lattice.cell;
    for (let iz = 0; iz < lattice.nz; iz++) {
      const w = lattice.originZ + iz * lattice.cell + centre.z;
      for (let ix = 0; ix < lattice.nx; ix++) {
        const u = lattice.originX + ix * lattice.cell + centre.x;
        if (!insideParts(parts, u * cos + w * sin, y, u * sin - w * cos)) continue;
        cells[index(lattice, ix, iy, iz)] = 1;
        count++;
      }
    }
  }
  return { lattice, cells, count };
}

/** Centre of the object's footprint in the camera frame, so it sits on 0. */
function footprintCentre(parts: Part[], azimuthDeg: number): { x: number; z: number } {
  const a = (azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const b = partsBounds(parts);
  let minU = Infinity;
  let maxU = -Infinity;
  let minW = Infinity;
  let maxW = -Infinity;
  for (const x of [b.min[0], b.max[0]]) {
    for (const z of [b.min[2], b.max[2]]) {
      const u = x * cos + z * sin;
      const w = x * sin - z * cos;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minW = Math.min(minW, w);
      maxW = Math.max(maxW, w);
    }
  }
  return { x: (minU + maxU) / 2, z: (minW + maxW) / 2 };
}

/** Extent of the photographed object in the camera frame, in object heights. */
export function truthExtent(
  parts: Part[],
  azimuthDeg: number,
): { width: number; depth: number; height: number } {
  const a = (azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const b = partsBounds(parts);
  let minU = Infinity;
  let maxU = -Infinity;
  let minW = Infinity;
  let maxW = -Infinity;
  for (const x of [b.min[0], b.max[0]]) {
    for (const z of [b.min[2], b.max[2]]) {
      const u = x * cos + z * sin;
      const w = x * sin - z * cos;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minW = Math.min(minW, w);
      maxW = Math.max(maxW, w);
    }
  }
  return { width: maxU - minU, depth: maxW - minW, height: b.max[1] - b.min[1] };
}

/**
 * The built model, voxelised in the same frame.
 *
 * One plate is 3.2mm and one stud is 8mm, so a model that is `gridY` plates tall
 * is one unit tall here and a stud is 2.5 plates wide. `flipZ` exists because
 * which end of the depth axis faces the camera is a convention, and a benchmark
 * that silently tries both would hide a real bug in the pipeline; the caller
 * reports the disagreement instead.
 */
export function modelOccupancy(
  result: BuildResult,
  lattice: Lattice,
  flipZ = false,
  scale = 1,
): Occupancy {
  const { gridX, gridY, gridZ } = result;
  const dense = new Uint8Array(gridX * gridY * gridZ);
  for (const p of result.placements) {
    for (let dy = 0; dy < p.height; dy++) {
      for (let dz = 0; dz < p.d; dz++) {
        for (let dx = 0; dx < p.w; dx++) {
          const x = p.x + dx;
          const y = p.y + dy;
          const z = p.z + dz;
          if (x < 0 || y < 0 || z < 0 || x >= gridX || y >= gridY || z >= gridZ) continue;
          dense[(y * gridZ + z) * gridX + x] = 1;
        }
      }
    }
  }

  const plate = scale / gridY;
  const stud = plate * (STUD_MM / PLATE_MM);
  const halfX = (gridX * stud) / 2;
  const halfZ = (gridZ * stud) / 2;

  const cells = new Uint8Array(lattice.nx * lattice.ny * lattice.nz);
  let count = 0;
  for (let iy = 0; iy < lattice.ny; iy++) {
    const gy = Math.floor((lattice.originY + iy * lattice.cell) / plate);
    if (gy < 0 || gy >= gridY) continue;
    for (let iz = 0; iz < lattice.nz; iz++) {
      const z = lattice.originZ + iz * lattice.cell;
      const gzRaw = Math.floor((z + halfZ) / stud);
      const gz = flipZ ? gridZ - 1 - gzRaw : gzRaw;
      if (gz < 0 || gz >= gridZ) continue;
      for (let ix = 0; ix < lattice.nx; ix++) {
        const gx = Math.floor((lattice.originX + ix * lattice.cell + halfX) / stud);
        if (gx < 0 || gx >= gridX) continue;
        if (!dense[(gy * gridZ + gz) * gridX + gx]) continue;
        cells[index(lattice, ix, iy, iz)] = 1;
        count++;
      }
    }
  }
  return { lattice, cells, count };
}

/** Extent of an occupancy along each axis, in object heights. */
export function extentOf(occ: Occupancy): { width: number; depth: number; height: number } {
  const { nx, ny, nz, cell } = occ.lattice;
  let minX = nx;
  let maxX = -1;
  let minY = ny;
  let maxY = -1;
  let minZ = nz;
  let maxZ = -1;
  for (let y = 0; y < ny; y++) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        if (!occ.cells[index(occ.lattice, x, y, z)]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  if (maxX < 0) return { width: 0, depth: 0, height: 0 };
  return {
    width: (maxX - minX + 1) * cell,
    depth: (maxZ - minZ + 1) * cell,
    height: (maxY - minY + 1) * cell,
  };
}

export interface Alignment {
  offset: [number, number, number];
  iou: number;
  /** Share of the true solid the model has nothing at. */
  missed: number;
  /** Volume the model invented, as a share of the true solid. */
  invented: number;
}

/**
 * Best integer registration of the model against the truth.
 *
 * A couple of cells of translation is the difference between "the model is a
 * stud to the left" and "the model is the wrong shape", and only the second is
 * worth reporting. The search is small on purpose — widen it and a shape that
 * is merely in the wrong place starts scoring like one that is right.
 */
export function align(truth: Occupancy, model: Occupancy): Alignment {
  const lattice = truth.lattice;
  const { nx, ny, nz } = lattice;
  const truthCells: number[] = [];
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++)
        if (truth.cells[index(lattice, x, y, z)]) truthCells.push((y * nz + z) * nx + x);

  let best: Alignment = { offset: [0, 0, 0], iou: 0, missed: 1, invented: 0 };
  for (let dy = -SEARCH_Y; dy <= SEARCH_Y; dy++) {
    for (let dz = -SEARCH_XZ; dz <= SEARCH_XZ; dz++) {
      for (let dx = -SEARCH_XZ; dx <= SEARCH_XZ; dx++) {
        let intersection = 0;
        for (const packed of truthCells) {
          const x = packed % nx;
          const z = Math.floor(packed / nx) % nz;
          const y = Math.floor(packed / (nx * nz));
          const mx = x + dx;
          const my = y + dy;
          const mz = z + dz;
          if (mx < 0 || my < 0 || mz < 0 || mx >= nx || my >= ny || mz >= nz) continue;
          if (model.cells[(my * nz + mz) * nx + mx]) intersection++;
        }
        const union = truth.count + model.count - intersection;
        const iou = union === 0 ? 0 : intersection / union;
        if (iou > best.iou) {
          best = {
            offset: [dx, dy, dz],
            iou,
            missed: truth.count === 0 ? 0 : (truth.count - intersection) / truth.count,
            invented: truth.count === 0 ? 0 : (model.count - intersection) / truth.count,
          };
        }
      }
    }
  }
  return best;
}

export interface Silhouette {
  mask: Uint8Array;
  width: number;
  height: number;
}

/**
 * Project an occupancy along a view direction, as the camera would see it.
 *
 * Angles are relative to the photograph the model was built from: (0, 0) is the
 * view the pipeline was given, and every other angle is one it never saw. That
 * is the entire value of this function. Silhouette agreement at (0, 0) is
 * nearly free — extruding the outline reproduces it by construction — and
 * agreement at 90 degrees, or from above, is not obtainable by any amount of
 * guessing about the axis the photograph does not contain.
 */
export function silhouette(occ: Occupancy, azimuthDeg: number, elevationDeg: number): Silhouette {
  const { nx, ny, nz, cell, originX, originY, originZ } = occ.lattice;
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  const cosE = Math.cos(e);
  const sinE = Math.sin(e);

  // Wide enough for any rotation of the lattice, so no view is ever clipped.
  const diagonal = Math.ceil(Math.hypot(nx, nz)) + 2;
  const tall = Math.ceil(ny * cosE + diagonal * Math.abs(sinE)) + 2;
  const width = diagonal;
  const height = tall;
  const mask = new Uint8Array(width * height);

  for (let iy = 0; iy < ny; iy++) {
    const y = originY + iy * cell;
    for (let iz = 0; iz < nz; iz++) {
      const z = originZ + iz * cell;
      for (let ix = 0; ix < nx; ix++) {
        if (!occ.cells[index(occ.lattice, ix, iy, iz)]) continue;
        const x = originX + ix * cell;
        const u = x * cosA + z * sinA;
        const w = -x * sinA + z * cosA;
        const v = y * cosE + w * sinE;
        const px = u / cell + width / 2;
        const py = height - 2 - v / cell;
        const fx = Math.floor(px);
        const fy = Math.floor(py);
        // A cell projects to somewhere between one and two pixels across
        // depending on the angle, so it is splatted over both. Truth and model
        // get the same treatment, which is what keeps the comparison fair.
        for (let sy = 0; sy <= 1; sy++) {
          for (let sx = 0; sx <= 1; sx++) {
            const qx = fx + sx;
            const qy = fy + sy;
            if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
            mask[qy * width + qx] = 1;
          }
        }
      }
    }
  }
  return { mask, width, height };
}

export function silhouetteIoU(a: Silhouette, b: Silhouette): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('silhouette size mismatch');
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.mask.length; i++) {
    if (a.mask[i] && b.mask[i]) intersection++;
    if (a.mask[i] || b.mask[i]) union++;
  }
  return union === 0 ? 0 : intersection / union;
}

/** Shift an occupancy by the registration found by `align`. */
export function shifted(occ: Occupancy, offset: [number, number, number]): Occupancy {
  const { nx, ny, nz } = occ.lattice;
  const [dx, dy, dz] = offset;
  const cells = new Uint8Array(occ.cells.length);
  let count = 0;
  for (let y = 0; y < ny; y++) {
    const sy = y + dy;
    if (sy < 0 || sy >= ny) continue;
    for (let z = 0; z < nz; z++) {
      const sz = z + dz;
      if (sz < 0 || sz >= nz) continue;
      for (let x = 0; x < nx; x++) {
        const sx = x + dx;
        if (sx < 0 || sx >= nx) continue;
        if (!occ.cells[(sy * nz + sz) * nx + sx]) continue;
        cells[(y * nz + z) * nx + x] = 1;
        count++;
      }
    }
  }
  return { lattice: occ.lattice, cells, count };
}

/**
 * The angles every object is scored from.
 *
 * FRONT is the photograph the model was built from and is reported apart from
 * the rest: it is the number the app already shows the user, and a flat
 * extrusion scores in the high nineties on it while looking like a loaf from
 * anywhere else. The mean of the other four is the number that cannot be faked.
 */
export const VIEWS: Array<{ name: string; azimuth: number; elevation: number; seen: boolean }> = [
  { name: 'front', azimuth: 0, elevation: 0, seen: true },
  { name: 'side', azimuth: 90, elevation: 0, seen: false },
  { name: 'top', azimuth: 0, elevation: 88, seen: false },
  { name: 'iso', azimuth: 45, elevation: 25, seen: false },
  { name: 'rear3q', azimuth: 135, elevation: 15, seen: false },
];
