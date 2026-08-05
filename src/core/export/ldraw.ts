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
import { findPart } from '../lego/catalog';
import type { BuildStep, Placement } from '../../types';

/** Identity, and a quarter turn about the vertical axis. */
const IDENTITY = '1 0 0 0 1 0 0 0 1';
const ROT_Y90 = '0 0 1 0 1 0 -1 0 0';

function lineFor(p: Placement): string | null {
  const part = findPart(p.w, p.d, p.height);
  if (!part) return null;

  const x = (p.x + p.w / 2) * LDU_PER_STUD;
  const z = (p.z + p.d / 2) * LDU_PER_STUD;
  // Y is down and part origins are at the bottom face.
  const y = -(p.y * LDU_PER_PLATE);

  // Catalogue parts are modelled with their long side along X.
  const matrix = p.w === part.b || part.a === part.b ? IDENTITY : ROT_Y90;

  return `1 ${p.color} ${x} ${y} ${z} ${matrix} ${part.code}.dat`;
}

export interface LdrawOptions {
  modelName: string;
  author: string;
  /** Emit `0 STEP` markers between build steps. */
  includeSteps: boolean;
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
