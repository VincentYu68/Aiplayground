/**
 * Turning "it is a coffee mug" into "so it is about as deep as it is wide".
 *
 * These numbers are priors on depth-to-width, and they only apply to the
 * single-photograph path — with two or more views the depth is measured from
 * the silhouettes and nothing here is consulted. That is the honest division:
 * guess only where there is no measurement.
 *
 * The values come from the oracle study in the README. A single fixed prior
 * tops out at 53.7% mean 3D IoU across the benchmark solids; picking per object
 * reaches 65.1%. Most of that gap is objects a geometric rule reads exactly
 * backwards — a flat box, a ring, a teapot whose silhouette is far wider than
 * its body.
 */

import type { Archetype, Recognition } from './recognise';
import type { SolidMode } from '../../types';

export interface ShapePrior {
  solidMode: SolidMode;
  depthScale: number;
  /** Sentence for the UI, so a wrong guess is visible and correctable. */
  explanation: string;
}

/**
 * How confident the pooled archetype has to be before it overrides the
 * default. Below this the classifier is guessing between shapes, and the
 * neutral prior is the better bet.
 */
export const MIN_CONFIDENCE = 0.35;

const DEFAULT_PRIOR: ShapePrior = {
  solidMode: 'symmetric',
  depthScale: 1.0,
  explanation: 'Assuming a roughly circular cross-section — as deep as it is wide.',
};

function priorFor(archetype: Archetype, label: string): ShapePrior {
  switch (archetype) {
    case 'T':
      // Bottles, mugs, vases, pots: turned about a vertical axis, so the
      // silhouette really does describe the solid.
      return {
        solidMode: 'revolve',
        depthScale: 1.0,
        explanation: `Looks like a ${label} — treating it as turned about a vertical axis.`,
      };
    case 'R':
      return {
        solidMode: 'symmetric',
        depthScale: 1.0,
        explanation: `Looks like a ${label} — rounded, about as deep as it is wide.`,
      };
    case 'B':
      return {
        solidMode: 'symmetric',
        depthScale: 0.7,
        explanation: `Looks like a ${label} — boxy, so a little shallower than it is wide.`,
      };
    case 'F':
      // Books, screens, discs: thin. This is the case a geometric prior gets
      // most wrong, and the one with the largest measured gain.
      return {
        solidMode: 'symmetric',
        depthScale: 0.3,
        explanation: `Looks like a ${label} — flat, so mostly outline with little depth.`,
      };
    default:
      return DEFAULT_PRIOR;
  }
}

/**
 * The prior to use, or null to leave the user's settings alone. Null is
 * returned whenever the recognition is too weak to act on, which is the common
 * case for objects ImageNet has no word for.
 */
export function shapePriorFor(recognition: Recognition | null): ShapePrior | null {
  if (!recognition) return null;
  if (recognition.archetype === 'U') return null;
  if (recognition.confidence < MIN_CONFIDENCE) return null;
  return priorFor(recognition.archetype, recognition.label);
}

export { DEFAULT_PRIOR };
