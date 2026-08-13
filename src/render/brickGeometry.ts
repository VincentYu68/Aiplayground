/**
 * Geometry for a single element, in millimetres.
 *
 * An element is a prism: a convex profile extruded across the part, with studs
 * on the cells that carry one. The details that decide whether that reads as
 * moulded ABS or as a Minecraft block are small:
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
 * - **Tiles and slopes have to actually be tiles and slopes.** They were in the
 *   model long before they were on the screen, drawn as plain studded boxes,
 *   and they are most of what breaks a real build up at a glance: a ramp on the
 *   silhouette instead of a staircase, and a tiled surface that is smooth
 *   instead of pebbled with studs.
 *
 * The profile and the per-cell stud mask both come from the catalogue —
 * `PartDef.slope` and `partCells` — rather than being re-derived here, so the
 * renderer and the exporter cannot disagree about where a slope's material is.
 *
 * Geometry is cached per (element, footprint, facing) and merged into a single
 * BufferGeometry so an entire model can be drawn with a handful of
 * InstancedMesh draw calls. The studless variant exists because in a solid
 * model most studs are buried under the course above: drawing them costs the
 * majority of the vertex budget and not one pixel of the result.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { partCells, type PartDef, type SlopeFacing } from '../core/lego/catalog';
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
 * A tile is moulded ~0.1mm wider than a plate, so tiles laid side by side very
 * nearly touch. That is not a detail — it is why a tiled surface reads as one
 * smooth panel and a plated one reads as a grid of separate parts.
 */
const TILE_CLEARANCE_MM = 0.1;

/**
 * The vertical face at the low end of a slope's ramp.
 *
 * The ramp does not run out to a knife edge on a real part; there is a small
 * upstand where the moulding wall is. It is worth having for its own sake — a
 * knife edge at 50 degrees renders as an aliased hairline — and it keeps the
 * chamfer well-formed at what would otherwise be a very acute corner.
 */
const SLOPE_LIP_MM = 0.9;

/**
 * Yaw that turns the canonical '+x' slope to each facing, in three's axes.
 *
 * This is deliberately **not** `SLOPE_ROTATION_DEG` from the catalogue. That
 * table is written for LDraw, whose Y axis points *down*, which reverses the
 * sense of every rotation about it: there '+z' is a quarter turn and here it is
 * three. Sharing the constant would put every z-facing ramp on the wrong side
 * of its brick, and the two conventions cannot both be right in one table.
 */
const FACING_YAW: Record<SlopeFacing, number> = {
  '+x': 0,
  '-x': Math.PI,
  '+z': -Math.PI / 2,
  '-z': Math.PI / 2,
};

/**
 * One element as placed.
 *
 * @param part catalogue definition — the shape, not a footprint lookup
 * @param w footprint along X in studs, as laid on the grid
 * @param d footprint along Z in studs, as laid on the grid
 * @param facing which way a slope's ramp descends; ignored by every other shape
 * @param studs false when the course above covers every stud on this part
 */
export function partGeometry(
  part: PartDef,
  w: number,
  d: number,
  facing: SlopeFacing,
  quality: Quality,
  studs: boolean,
): THREE.BufferGeometry {
  const key = `${part.id}|${w}x${d}|${facing}|${studs ? 's' : '-'}|${quality.tier}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const clearance = part.shape === 'tile' ? TILE_CLEARANCE_MM : PART_CLEARANCE_MM;
  const height = part.height * PLATE_MM;
  // The profile is drawn in the plane the ramp runs in and the part is extruded
  // across it, so for a z-facing slope the roles of w and d swap. The finished
  // geometry is turned back to the grid by FACING_YAW.
  const alongX = facing === '+x' || facing === '-x';
  const lengthStuds = alongX ? w : d;
  const widthStuds = alongX ? d : w;

  const parts: THREE.BufferGeometry[] = [];
  const body = chamferedPrism(
    profileFor(part, lengthStuds, lengthStuds * STUD_MM - clearance, height),
    widthStuds * STUD_MM - clearance,
    quality.bodyChamferMM,
  );
  if (FACING_YAW[facing] !== 0) body.rotateY(FACING_YAW[facing]);
  parts.push(body);

  if (studs && part.studs > 0) {
    const prototype = studGeometry(quality);
    // Which cells carry a stud is the catalogue's answer, not ours: a 45 degree
    // slope keeps them only on the course the ramp did not eat, and an inverted
    // one keeps the lot.
    for (const cell of partCells(part, w, d, facing)) {
      if (!cell.stud) continue;
      const stud = prototype.clone();
      stud.translate(
        (cell.dx + 0.5) * STUD_MM - (w * STUD_MM) / 2,
        height,
        (cell.dz + 0.5) * STUD_MM - (d * STUD_MM) / 2,
      );
      parts.push(stud);
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
  return chamferedPrism(boxProfile(width, height), depth, 0.4);
}

/** Rectangular cross-section, centred on x, standing on y = 0. */
function boxProfile(width: number, height: number): THREE.Vector2[] {
  const hx = width / 2;
  return [
    new THREE.Vector2(-hx, 0),
    new THREE.Vector2(hx, 0),
    new THREE.Vector2(hx, height),
    new THREE.Vector2(-hx, height),
  ];
}

/**
 * Cross-section of one element in the plane its ramp runs in, for the canonical
 * '+x' facing: the ramp descends toward increasing x, so the high end is at
 * -x. Everything that is not a slope is a rectangle.
 */
function profileFor(
  part: PartDef,
  lengthStuds: number,
  length: number,
  height: number,
): THREE.Vector2[] {
  const ramp = part.shape === 'slope' ? part.slope : undefined;
  if (!ramp) return boxProfile(length, height);

  const hx = length / 2;
  // Clamped the same way partCells clamps it, so a malformed placement degrades
  // to a plain box in both places rather than to two different wrong shapes.
  const run = Math.min(ramp.run, lengthStuds);
  const breakX = -hx + (length * (lengthStuds - run)) / lengthStuds;
  const lip = Math.min(SLOPE_LIP_MM, height * 0.3);
  const v = (x: number, y: number) => new THREE.Vector2(x, y);

  // Inverted slopes keep the flat studded top and cut the underside away
  // instead — the part you put under an overhang.
  if (ramp.inverted) {
    return [v(-hx, 0), v(breakX, 0), v(hx, height - lip), v(hx, height), v(-hx, height)];
  }
  return [v(-hx, 0), v(hx, 0), v(hx, lip), v(breakX, height), v(-hx, height)];
}

/**
 * A convex profile extruded along Z with every edge cut back at 45°.
 *
 * Each solid vertex meets exactly three faces — the cap it is on and the two
 * profile edges either side — so it becomes three vertices, one pulled back
 * onto each of them. Faces become inset polygons, edges become strips and
 * vertices become triangles: 12n - 4 triangles for an n-sided profile, so 44
 * for a box and 56 for a slope. Flat-shaded on purpose — the chamfer needs its
 * own normal or it cannot catch the highlight that is most of what sells the
 * material.
 *
 * The cut-back along each edge is clamped to under half that edge's length, or
 * a short edge — the 0.9mm lip at the foot of a ramp — would be eaten from both
 * ends at once and turn itself inside out.
 */
function chamferedPrism(
  profile: THREE.Vector2[],
  width: number,
  chamfer: number,
): THREE.BufferGeometry {
  const n = profile.length;
  const hz = width / 2;

  const dir: THREE.Vector2[] = [];
  const cut: number[] = [];
  for (let i = 0; i < n; i++) {
    const step = new THREE.Vector2().subVectors(profile[(i + 1) % n], profile[i]);
    const len = step.length();
    dir.push(len > 0 ? step.divideScalar(len) : new THREE.Vector2(1, 0));
    cut.push(Math.min(chamfer, len * 0.45));
  }
  const cz = Math.min(chamfer, hz * 0.8);

  // Three chamfer vertices per solid vertex, indexed [i][cap], cap 0 = -Z.
  const onCap: THREE.Vector3[][] = [];
  const onPrev: THREE.Vector3[][] = [];
  const onNext: THREE.Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const p = profile[i];
    const back = dir[(i + n - 1) % n];
    const cb = cut[(i + n - 1) % n];
    const fwd = dir[i];
    const cf = cut[i];
    const cap: THREE.Vector3[] = [];
    const prev: THREE.Vector3[] = [];
    const next: THREE.Vector3[] = [];
    for (const s of [-1, 1]) {
      cap.push(new THREE.Vector3(p.x - back.x * cb + fwd.x * cf, p.y - back.y * cb + fwd.y * cf, s * hz));
      prev.push(new THREE.Vector3(p.x - back.x * cb, p.y - back.y * cb, s * (hz - cz)));
      next.push(new THREE.Vector3(p.x + fwd.x * cf, p.y + fwd.y * cf, s * (hz - cz)));
    }
    onCap.push(cap);
    onPrev.push(prev);
    onNext.push(next);
  }

  // Any interior point will do to orient the facets; the average of a convex
  // profile's vertices is one.
  const inside = new THREE.Vector3();
  for (const p of profile) inside.add(new THREE.Vector3(p.x, p.y, 0));
  inside.divideScalar(n);

  const position: number[] = [];
  const normal: number[] = [];
  const emit = (pts: THREE.Vector3[]) => face(position, normal, pts, inside);

  for (const c of [0, 1]) emit(onCap.map((v) => v[c]));

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // The flank standing on profile edge i.
    emit([onNext[i][0], onNext[i][1], onPrev[j][1], onPrev[j][0]]);
    // The strip along that edge, on each cap.
    for (const c of [0, 1]) emit([onCap[i][c], onCap[j][c], onPrev[j][c], onNext[i][c]]);
    // The strip along the width, where two flanks meet.
    emit([onPrev[i][0], onPrev[i][1], onNext[i][1], onNext[i][0]]);
    // And the corner each solid vertex becomes.
    for (const c of [0, 1]) emit([onCap[i][c], onPrev[i][c], onNext[i][c]]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setIndex([...Array(position.length / 3).keys()]);
  return geo;
}

/**
 * Triangulate one flat convex polygon of a solid, given any point inside it.
 * Winding is derived rather than hand-written: the outward normal of a convex
 * hull facet always points away from the interior, which is far less error-prone
 * than tracking vertex order through thirty-odd facets by hand.
 */
function face(
  position: number[],
  normal: number[],
  pts: THREE.Vector3[],
  inside: THREE.Vector3,
): void {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.lengthSq() === 0) return;
  n.normalize();
  const centre = new THREE.Vector3();
  for (const p of pts) centre.add(p);
  centre.divideScalar(pts.length).sub(inside);

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
