/**
 * Geometry for a single element, in millimetres.
 *
 * A brick is a box with studs on top. Modelling the studs matters more than it
 * sounds: they are what makes a render read as LEGO rather than as Minecraft,
 * and they let the builder see at a glance which way a part is oriented.
 *
 * Geometry is cached per footprint and merged into a single BufferGeometry so
 * an entire model can be drawn with a handful of InstancedMesh draw calls.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  PART_CLEARANCE_MM,
  PLATE_MM,
  STUD_DIAMETER_MM,
  STUD_HEIGHT_MM,
  STUD_MM,
} from '../core/lego/units';

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * @param w footprint along X in studs
 * @param d footprint along Z in studs
 * @param heightPlates 1 for a plate, 3 for a brick
 */
export function brickGeometry(w: number, d: number, heightPlates: number): THREE.BufferGeometry {
  const key = `${w}x${d}x${heightPlates}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const bw = w * STUD_MM - PART_CLEARANCE_MM;
  const bd = d * STUD_MM - PART_CLEARANCE_MM;
  const bh = heightPlates * PLATE_MM;

  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(bw, bh, bd);
  body.translate(0, bh / 2, 0);
  parts.push(body);

  const studRadius = STUD_DIAMETER_MM / 2;
  for (let iz = 0; iz < d; iz++) {
    for (let ix = 0; ix < w; ix++) {
      const stud = new THREE.CylinderGeometry(studRadius, studRadius, STUD_HEIGHT_MM, 12, 1, false);
      stud.translate(
        (ix + 0.5) * STUD_MM - (w * STUD_MM) / 2,
        bh + STUD_HEIGHT_MM / 2,
        (iz + 0.5) * STUD_MM - (d * STUD_MM) / 2,
      );
      parts.push(stud);
    }
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const geometry = merged ?? body;
  geometry.computeVertexNormals();
  cache.set(key, geometry);
  return geometry;
}
