/**
 * Turning "it is a coffee mug" into "so it is about as deep as it is wide".
 *
 * These are priors on how deep an object is and how its cross-section closes,
 * and they only apply to the single-photograph path — with two or more views the
 * depth is measured from the silhouettes and nothing here is consulted. That is
 * the honest division: guess only where there is no measurement.
 *
 * The numbers were re-derived when `depthScale` changed meaning. It used to be
 * depth as a fraction of the photograph's *width*, which is meaningless for
 * anything not photographed square-on — a car side-on was "as deep as it is
 * long". It is now depth as a fraction of the object's **short visible axis**,
 * which is a quantity these classes actually constrain: a car is about as deep
 * as it is tall, a bottle about as deep as it is wide, a book barely at all.
 *
 * The old values were also fitted against the bulge that `estimateDepth`
 * invents, on a corpus of flat vector drawings. Both of those are gone, so the
 * figures below are proportions of real objects rather than a fit, and they are
 * stated as such: they are what a person would guess knowing only the noun.
 *
 * How much any of this is worth depends on the classifier being right, and on
 * photographs it is right about two thirds of the time. Measured on the
 * benchmark corpus: a mug is correctly called a body of revolution and a teddy
 * bear correctly called rounded, but a car is called a "jigsaw puzzle" —
 * archetype flat — confidently enough to clear `MIN_CONFIDENCE`. That single
 * miss turned a 32x16-stud car into a 32x3-stud sheet. Nothing here can tell a
 * good guess from a bad one, so `bracketByRelief` in the voxeliser limits how
 * far `depthScale` may end up from what the depth map measured. Treat these
 * numbers as a nudge that the evidence is allowed to overrule.
 */

import type { Archetype, Recognition } from './recognise';
import type { SolidMode } from '../../types';

export interface ShapePrior {
  solidMode: SolidMode;
  /** Depth as a fraction of the object's short visible axis. */
  depthScale: number;
  /**
   * How the cross-section closes at the silhouette: 1 circular, 0 a slab with a
   * rounded edge. Independent of depth — a suitcase is shallow *and* square in
   * section, a ball is deep *and* round, and confusing the two is what makes a
   * boxy object come out as a lozenge.
   */
  roundness: number;
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
  depthScale: 0.95,
  roundness: 0.55,
  explanation: 'Assuming a roughly circular cross-section — as deep as it is wide.',
};

function priorFor(archetype: Archetype, label: string): ShapePrior {
  switch (archetype) {
    case 'T':
      // Bottles, mugs, vases, pots: turned about a vertical axis, so the
      // silhouette really does describe the solid, and revolve mode takes the
      // depth from the body's own radius rather than from `depthScale`.
      return {
        solidMode: 'revolve',
        depthScale: 1.0,
        roundness: 1,
        explanation: `Looks like a ${label} — treating it as turned about a vertical axis.`,
      };
    case 'R':
      // Fruit, balls, animals, soft toys. Round in section, and a touch
      // shallower than the short axis because most of them are not spheres.
      return {
        solidMode: 'symmetric',
        depthScale: 0.9,
        roundness: 0.9,
        explanation: `Looks like a ${label} — rounded, about as deep as it is wide.`,
      };
    case 'B':
      // Cars, chairs, appliances, boxes. Roughly as deep as they are tall, but
      // square in section: the old 0.7 was against the *width*, which for a car
      // side-on meant "as deep as it is long times 0.7", i.e. a cube.
      return {
        solidMode: 'symmetric',
        depthScale: 0.85,
        roundness: 0.25,
        explanation: `Looks like a ${label} — boxy, so a squared-off cross-section.`,
      };
    case 'F':
      // Books, screens, discs, signs. This is the case a geometric rule reads
      // most wrongly, because their short visible axis is still nothing like
      // their thickness.
      return {
        solidMode: 'symmetric',
        depthScale: 0.22,
        roundness: 0.1,
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
