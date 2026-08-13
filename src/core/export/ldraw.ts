/**
 * LDraw (.ldr) export.
 *
 * The point of this is that the model does not stay trapped in one web page:
 * an .ldr file opens in Bricklink Studio, LeoCAD, LDView and Blender, where it
 * can be rendered, priced, or turned into a real order. Build steps are written
 * as `0 STEP` separators, so the manual survives the round trip too.
 *
 * LDraw geometry notes: 1 LDU = 0.4mm, a stud is 20 LDU, a plate is 8 LDU, and
 * Y points *down*. Brick origins sit at the centre of the part's bottom face,
 * with the longer footprint dimension running along X.
 */

import { LDU_PER_PLATE, LDU_PER_STUD } from '../lego/units';
import { findPart, type BaseplateChoice, PART_BY_ID, type SlopeFacing } from '../lego/catalog';
import type { BuildStep, Placement } from '../../types';

/** Identity, and a quarter turn about the vertical axis. */
const IDENTITY = '1 0 0 0 1 0 0 0 1';
const ROT_Y90 = '0 0 1 0 1 0 -1 0 0';
const ROT_Y180 = '-1 0 0 0 1 0 0 0 -1';
const ROT_Y270 = '0 0 -1 0 1 0 1 0 0';

/**
 * Rotation for each direction a slope descends toward.
 *
 * Anchored on LDraw's own convention for 3040: the ramp descends toward -Z at
 * the identity orientation, and LDraw's Y points down, so its -Z is the
 * grid's +z once the model is stood up. **This mapping is unverified against
 * LDView** -- nobody here has opened a slope in a viewer -- so if slopes come
 * out facing the wrong way in a real editor, this table is the thing to turn,
 * and turning it cannot break anything else.
 */
const SLOPE_MATRIX: Record<SlopeFacing, string> = {
  '+z': IDENTITY,
  '-x': ROT_Y90,
  '-z': ROT_Y180,
  '+x': ROT_Y270,
};

function lineFor(p: Placement): string | null {
  // By id, not by footprint. A tile has a plate's height and a slope has a
  // brick's, so looking them up by (w, d, height) silently exported every tile
  // as 3023 and every slope as 3004: the parts list said one thing and the
  // file the user opens said another.
  const part = PART_BY_ID.get(p.partId) ?? findPart(p.w, p.d, p.height);
  if (!part) return null;

  const x = (p.x + p.w / 2) * LDU_PER_STUD;
  const z = (p.z + p.d / 2) * LDU_PER_STUD;
  // Y is down and part origins are at the bottom face.
  const y = -(p.y * LDU_PER_PLATE);

  // A slope's orientation is carried by `facing` and never by the footprint, so
  // it rotates about Y by its own angle. Everything else is a rectangle:
  // catalogue parts are modelled with their long side along X, so a part laid
  // the other way round is the same element turned ninety degrees.
  const matrix =
    part.shape === 'slope' && p.facing
      ? SLOPE_MATRIX[p.facing]
      : p.w === part.b || part.a === part.b
        ? IDENTITY
        : ROT_Y90;

  return `1 ${p.color} ${x} ${y} ${z} ${matrix} ${part.code}.dat`;
}

export interface LdrawOptions {
  modelName: string;
  author: string;
  /** Emit `0 STEP` markers between build steps. */
  includeSteps: boolean;
  /**
   * The base to stand the model on, written as the first step.
   *
   * Left out entirely before, while the app told the user to buy one — so the
   * exported model floated and the file disagreed with the advice beside it.
   */
  baseplate?: BaseplateChoice | null;
  /** Model footprint in studs, needed to centre and tile the base under it. */
  gridX?: number;
  gridZ?: number;
}

/**
 * Baseplate lines.
 *
 * LDraw baseplate parts are modelled with their top surface on the y = 0 plane
 * and their thickness below it, which is the same plane the first course of
 * bricks sits on, so they place at y = 0 with no offset. Tiled bases are laid
 * out from the model's minimum corner rather than centred on it, so the model
 * never straddles a seam differently from how the viewer shows it.
 */
function baseplateLines(plate: BaseplateChoice, gridX: number, gridZ: number): string[] {
  const lines: string[] = [];
  for (let dz = 0; dz < plate.deep; dz++) {
    for (let dx = 0; dx < plate.across; dx++) {
      // Centre of this plate, in studs, measured from the model's origin. A
      // single plate is centred on the model; a tiled one starts at the corner.
      const cx =
        plate.count === 1
          ? gridX / 2
          : dx * plate.studs + plate.studs / 2;
      const cz =
        plate.count === 1
          ? gridZ / 2
          : dz * plate.studs + plate.studs / 2;
      lines.push(`1 7 ${cx * LDU_PER_STUD} 0 ${cz * LDU_PER_STUD} ${IDENTITY} ${plate.code}.dat`);
    }
  }
  return lines;
}

export function toLdraw(
  steps: BuildStep[],
  options: Partial<LdrawOptions> = {},
): string {
  const opts: LdrawOptions = {
    modelName: 'Brickify model',
    author: 'Brickify',
    includeSteps: true,
    ...options,
  };

  const out: string[] = [];
  out.push(`0 FILE ${opts.modelName}.ldr`);
  out.push(`0 ${opts.modelName}`);
  out.push(`0 Name: ${opts.modelName}.ldr`);
  out.push(`0 Author: ${opts.author}`);
  out.push('0 !LDRAW_ORG Unofficial_Model');
  out.push('0 BFC CERTIFY CCW');
  out.push('');

  // The base is its own first step: it is the one thing that has to be on the
  // table before anything else can be placed.
  if (opts.baseplate) {
    for (const line of baseplateLines(opts.baseplate, opts.gridX ?? 0, opts.gridZ ?? 0)) {
      out.push(line);
    }
    if (opts.includeSteps) out.push('0 STEP');
  }

  for (const step of steps) {
    for (const p of step.placements) {
      const line = lineFor(p);
      if (line) out.push(line);
    }
    if (opts.includeSteps && step.index < steps.length - 1) out.push('0 STEP');
  }
  out.push('0');
  return out.join('\n');
}
