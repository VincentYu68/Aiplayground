/**
 * Cavity occlusion, read out of the model's own occupancy grid.
 *
 * Screen-space AO would mean a depth/normal prepass plus a blur every single
 * frame, and this scene does not need it: the model *is* a voxel grid, so how
 * enclosed a point is can be looked up directly. Rasterise occupancy into a
 * small volume, blur it once, and one texture fetch per fragment says how much
 * brick is sitting around that point. It costs nothing while the camera moves,
 * it is stable instead of crawling with view-dependent noise, and it darkens
 * exactly the places a photograph does: the crack between two bricks, the
 * underside of an overhang, the ring where a part meets the baseplate.
 *
 * The volume is sampled in world millimetres, so the same texture serves the
 * bricks and the baseplate.
 */

import * as THREE from 'three';
import { partCells, PART_BY_ID } from '../core/lego/catalog';
import { PLATE_MM, STUD_MM } from '../core/lego/units';
import type { Placement } from '../types';

/** Half a stud across, one plate tall: close enough to isotropic to blur. */
const CELL_XZ = STUD_MM / 2;
const CELL_Y = PLATE_MM;
/** Empty margin so a sample taken just outside the model reads as open air. */
const PAD = 4;
/** Box-blur half-width, in cells. Two passes make the falloff roughly gaussian. */
const BLUR = 2;

export interface CavityVolume {
  texture: THREE.Data3DTexture;
  /** World position of the volume's minimum corner, mm. */
  min: THREE.Vector3;
  /** 1 / world extent, mm. */
  invSize: THREE.Vector3;
}

export function buildCavityVolume(
  placements: readonly Placement[],
  gridX: number,
  gridY: number,
  gridZ: number,
): CavityVolume {
  const nx = gridX * 2 + PAD * 2;
  const ny = gridY + PAD * 2;
  const nz = gridZ * 2 + PAD * 2;
  const data = new Uint8Array(nx * ny * nz);
  const at = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  // The baseplate is part of the scene the bricks sit on, so it occludes too:
  // without it the bottom course floats, lit identically all the way round.
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < PAD; y++) data.fill(255, at(0, y, z), at(0, y, z) + nx);

  for (const p of placements) {
    const part = PART_BY_ID.get(p.partId);
    // Only a slope has cells that are not full, and asking the catalogue cell by
    // cell for every part in a few-thousand-part model is a lot of allocation
    // for an answer that is "all of it" nearly every time.
    if (!part || part.shape !== 'slope') {
      const y0 = p.y + PAD;
      const y1 = p.y + p.height + PAD;
      const x0 = p.x * 2 + PAD;
      const x1 = (p.x + p.w) * 2 + PAD;
      for (let z = p.z * 2 + PAD; z < (p.z + p.d) * 2 + PAD; z++)
        for (let y = y0; y < y1; y++) data.fill(255, at(x0, y, z), at(x1, y, z));
      continue;
    }
    // Under a ramp the cell is only part full, and filling it solid shades the
    // open air beside the slope as though it were inside the model — which
    // takes the light out of exactly the diagonal the slope was placed to show.
    for (const c of partCells(part, p.w, p.d, p.facing ?? '+x')) {
      const y0 = p.y + Math.round(c.bottom) + PAD;
      const y1 = p.y + Math.round(c.top) + PAD;
      const x0 = (p.x + c.dx) * 2 + PAD;
      const x1 = x0 + 2;
      for (let z = (p.z + c.dz) * 2 + PAD; z < (p.z + c.dz) * 2 + 2 + PAD; z++)
        for (let y = y0; y < y1; y++) data.fill(255, at(x0, y, z), at(x1, y, z));
    }
  }

  const scratch = new Uint8Array(data.length);
  for (let pass = 0; pass < 2; pass++) {
    blurAxis(data, scratch, nx, ny, nz, 1, nx, ny * nx);
    blurAxis(data, scratch, ny, nx, nz, nx, 1, ny * nx);
    blurAxis(data, scratch, nz, nx, ny, ny * nx, 1, nx);
  }

  const texture = new THREE.Data3DTexture(data, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return {
    texture,
    min: new THREE.Vector3(-PAD * CELL_XZ, -PAD * CELL_Y, -PAD * CELL_XZ),
    invSize: new THREE.Vector3(1 / (nx * CELL_XZ), 1 / (ny * CELL_Y), 1 / (nz * CELL_XZ)),
  };
}

/** One separable box-blur pass along an arbitrary axis of the volume. */
function blurAxis(
  data: Uint8Array,
  scratch: Uint8Array,
  length: number,
  outerA: number,
  outerB: number,
  stride: number,
  strideA: number,
  strideB: number,
): void {
  const window = BLUR * 2 + 1;
  for (let b = 0; b < outerB; b++) {
    for (let a = 0; a < outerA; a++) {
      const base = a * strideA + b * strideB;
      let sum = 0;
      for (let i = -BLUR; i <= BLUR; i++) sum += data[base + clamp(i, length) * stride];
      for (let i = 0; i < length; i++) {
        scratch[base + i * stride] = sum / window;
        sum += data[base + clamp(i + BLUR + 1, length) * stride];
        sum -= data[base + clamp(i - BLUR, length) * stride];
      }
    }
  }
  data.set(scratch);
}

function clamp(i: number, length: number): number {
  return i < 0 ? 0 : i >= length ? length - 1 : i;
}
