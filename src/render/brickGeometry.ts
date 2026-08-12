/**
 * Geometry for a single element, in millimetres.
 *
 * A brick is a box with studs on top, and the details that decide whether that
 * reads as moulded ABS or as a Minecraft block are small:
 *
 * - **Nothing on a real brick is a knife edge.** Injection moulding leaves a
 *   consistent fillet everywhere, so every edge here is chamfered. That is also
 *   the only reason a seam between two same-coloured bricks is visible at all:
 *   two chamfers plus the moulding clearance make a ~0.8mm groove that catches
 *   a specular line down each side, so the join reads as bright/dark/bright
 *   instead of vanishing into a single mass of colour.
 * - **A stud is short and wide** — 4.8mm across, 1.8mm tall, on an 8mm pitch —
 *   with a chamfered rim and a fillet where it meets the top face. Get those
 *   proportions wrong and the model stops looking like LEGO immediately.
 *
 * Geometry is cached per footprint and merged into a single BufferGeometry so
 * an entire model can be drawn with a handful of InstancedMesh draw calls. The
 * studless variant exists because in a solid model most studs are buried under
 * the course above: drawing them costs the majority of the vertex budget and
 * not one pixel of the result.
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
import type { Quality } from './quality';

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * @param w footprint along X in studs
 * @param d footprint along Z in studs
 * @param heightPlates 1 for a plate, 3 for a brick
 * @param studs false when the course above covers every stud on this part
 */
export function brickGeometry(
  w: number,
  d: number,
  heightPlates: number,
  quality: Quality,
  studs = true,
): THREE.BufferGeometry {
  const key = `${w}x${d}x${heightPlates}|${studs ? 's' : '-'}|${quality.tier}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const bw = w * STUD_MM - PART_CLEARANCE_MM;
  const bd = d * STUD_MM - PART_CLEARANCE_MM;
  const bh = heightPlates * PLATE_MM;

  const parts: THREE.BufferGeometry[] = [];
  const body = chamferedBox(bw, bh, bd, quality.bodyChamferMM);
  body.translate(0, bh / 2, 0);
  parts.push(body);

  if (studs) {
    const prototype = studGeometry(quality);
    for (let iz = 0; iz < d; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const stud = prototype.clone();
        stud.translate(
          (ix + 0.5) * STUD_MM - (w * STUD_MM) / 2,
          bh,
          (iz + 0.5) * STUD_MM - (d * STUD_MM) / 2,
        );
        parts.push(stud);
      }
    }
    prototype.dispose();
  }

  const merged = mergeGeometries(parts, false) ?? body;
  if (merged !== body) for (const p of parts) p.dispose();
  cache.set(key, merged);
  return merged;
}

/** A LEGO baseplate stud, sitting on y = 0. Shares the brick's stud profile. */
export function studOnlyGeometry(quality: Quality): THREE.BufferGeometry {
  const key = `stud|${quality.tier}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const geo = studGeometry(quality);
  cache.set(key, geo);
  return geo;
}

/**
 * A bare chamfered slab, sized in millimetres. Used for the baseplate, which is
 * thinner than a plate and wider than any part in the catalogue — scaling a
 * cached brick to fit would stretch its chamfer along with it and put a 13mm
 * bevel down the long side.
 */
export function slabGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  const geo = chamferedBox(width, height, depth, 0.4);
  geo.translate(0, height / 2, 0);
  return geo;
}

/**
 * A box with every edge cut back at 45°: six inset faces, twelve edge strips
 * and eight corner triangles, 44 triangles in all. Flat-shaded on purpose —
 * the chamfer needs its own normal or it cannot catch the highlight that is
 * most of what sells the material.
 */
function chamferedBox(width: number, height: number, depth: number, chamfer: number): THREE.BufferGeometry {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  const c = Math.min(chamfer, hx * 0.4, hy * 0.4, hz * 0.4);

  const position: number[] = [];
  const normal: number[] = [];

  // Each original corner becomes three vertices, one pulled back onto each of
  // the faces meeting there.
  const onX = (sx: number, sy: number, sz: number) =>
    new THREE.Vector3(sx * hx, sy * (hy - c), sz * (hz - c));
  const onY = (sx: number, sy: number, sz: number) =>
    new THREE.Vector3(sx * (hx - c), sy * hy, sz * (hz - c));
  const onZ = (sx: number, sy: number, sz: number) =>
    new THREE.Vector3(sx * (hx - c), sy * (hy - c), sz * hz);

  const cycle: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];

  for (const s of [-1, 1]) {
    face(position, normal, cycle.map(([a, b]) => onX(s, a, b)));
    face(position, normal, cycle.map(([a, b]) => onY(a, s, b)));
    face(position, normal, cycle.map(([a, b]) => onZ(a, b, s)));
  }

  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      // Edges running along Z, X and Y respectively.
      face(position, normal, [onX(a, b, -1), onX(a, b, 1), onY(a, b, 1), onY(a, b, -1)]);
      face(position, normal, [onY(-1, a, b), onY(1, a, b), onZ(1, a, b), onZ(-1, a, b)]);
      face(position, normal, [onX(a, -1, b), onX(a, 1, b), onZ(a, 1, b), onZ(a, -1, b)]);
    }
  }

  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        face(position, normal, [onX(sx, sy, sz), onY(sx, sy, sz), onZ(sx, sy, sz)]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setIndex([...Array(position.length / 3).keys()]);
  return geo;
}

/**
 * Triangulate one flat convex polygon of a solid centred on the origin.
 * Winding is derived rather than hand-written: the outward normal of a convex
 * hull facet always points away from the centre, which is far less error-prone
 * than tracking vertex order through 26 facets by hand.
 */
function face(position: number[], normal: number[], pts: THREE.Vector3[]): void {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  n.normalize();
  const centre = new THREE.Vector3();
  for (const p of pts) centre.add(p);
  centre.divideScalar(pts.length);

  let ordered = pts;
  if (n.dot(centre) < 0) {
    n.negate();
    ordered = [...pts].reverse();
  }
  for (let i = 1; i + 1 < ordered.length; i++) {
    for (const p of [ordered[0], ordered[i], ordered[i + 1]]) {
      position.push(p.x, p.y, p.z);
      normal.push(n.x, n.y, n.z);
    }
  }
}

/**
 * One stud, base at y = 0. Built as a surface of revolution from a profile so
 * the bands stay separate: the wall, the rim chamfer and the base fillet each
 * keep their own normal, which is what puts a crisp highlight ring around the
 * top of every stud instead of a soft smear.
 */
function studGeometry(quality: Quality): THREE.BufferGeometry {
  const seg = quality.studSegments;
  const r = STUD_DIAMETER_MM / 2;
  const h = STUD_HEIGHT_MM;
  const rim = quality.studChamferMM;
  const fil = quality.studFilletMM;

  // [radius, y, radial normal, up normal] pairs; consecutive entries make a band.
  const diag = Math.SQRT1_2;
  const bands: Array<[number, number, number, number]> = [];
  if (fil > 0) {
    bands.push([r + fil, 0, diag, diag], [r, fil, diag, diag]);
  }
  bands.push([r, fil, 1, 0], [r, h - rim, 1, 0]);
  if (rim > 0) bands.push([r, h - rim, diag, diag], [r - rim, h, diag, diag]);

  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];

  const ringAt = (radius: number, y: number, nr: number, ny: number): number => {
    const base = position.length / 3;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      position.push(cos * radius, y, sin * radius);
      normal.push(cos * nr, ny, sin * nr);
    }
    return base;
  };

  for (let b = 0; b < bands.length; b += 2) {
    const lo = ringAt(...bands[b]);
    const hi = ringAt(...bands[b + 1]);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      index.push(lo + i, hi + i, hi + j, lo + i, hi + j, lo + j);
    }
  }

  // Top cap. The centre vertex keeps the fan cheap; a stud is never seen from
  // close enough for the triangulation to show.
  const capR = r - rim;
  const cap = ringAt(capR, h, 0, 1);
  const centre = position.length / 3;
  position.push(0, h, 0);
  normal.push(0, 1, 0);
  for (let i = 0; i < seg; i++) index.push(cap + i, centre, cap + ((i + 1) % seg));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setIndex(index);
  return geo;
}
