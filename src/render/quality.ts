/**
 * How much of the brick to actually draw.
 *
 * Everything that makes a moulded brick read as plastic rather than as a voxel
 * — the chamfer on every edge, the facets on a stud, a shadow map, cavity
 * occlusion — costs either vertices or fragments, and a finished model runs to
 * a few thousand parts. So the trimmings are grouped into named tiers instead
 * of being dropped silently on slow hardware: whoever is looking at a cheap
 * render can see which one they got.
 *
 * The body chamfer is in every tier. It is nearly free (44 triangles against a
 * cube's 12) and it is the single detail doing the most work — without it two
 * touching bricks of the same colour merge into one undifferentiated lump.
 */

export type QualityTier = 'high' | 'medium' | 'low';

export interface Quality {
  tier: QualityTier;
  /** Radial segments per stud. */
  studSegments: number;
  /** Chamfer on the stud's top rim, mm. 0 draws a bare cylinder. */
  studChamferMM: number;
  /** Fillet where a stud meets the brick's top face, mm. 0 for none. */
  studFilletMM: number;
  /** Chamfer on every edge of the body, mm. */
  bodyChamferMM: number;
  /** Directional shadow map, or none. */
  shadowMapSize: number;
  softShadows: boolean;
  /** Cavity occlusion sampled from the model's own occupancy volume. */
  cavityAO: boolean;
}

const HIGH: Quality = {
  tier: 'high',
  studSegments: 16,
  studChamferMM: 0.3,
  studFilletMM: 0.22,
  bodyChamferMM: 0.4,
  // 1024 rather than 2048: at the size a model occupies this is still well
  // under half a millimetre per texel, and the extra blur that comes with the
  // coarser map is closer to a softbox than a razor-sharp edge would be.
  shadowMapSize: 1024,
  softShadows: true,
  cavityAO: true,
};

const MEDIUM: Quality = {
  tier: 'medium',
  studSegments: 10,
  studChamferMM: 0.3,
  studFilletMM: 0,
  bodyChamferMM: 0.4,
  shadowMapSize: 512,
  softShadows: false,
  cavityAO: true,
};

const LOW: Quality = {
  tier: 'low',
  studSegments: 8,
  studChamferMM: 0,
  studFilletMM: 0,
  bodyChamferMM: 0.4,
  shadowMapSize: 0,
  softShadows: false,
  cavityAO: false,
};

export const QUALITY: Record<QualityTier, Quality> = { high: HIGH, medium: MEDIUM, low: LOW };

/**
 * Which tier to open with.
 *
 * Part count is the honest predictor here — it drives both the vertex load and
 * how much of the frame ends up covered in brick — but an explicit `?render=`
 * in the URL always wins so a tier can be compared against another without
 * having to find a model of the right size.
 */
export function pickQuality(parts: number, search = typeof location === 'undefined' ? '' : location.search): Quality {
  const asked = new URLSearchParams(search).get('render');
  if (asked === 'high' || asked === 'medium' || asked === 'low') return QUALITY[asked];
  if (parts > 20000) return LOW;
  if (parts > 7000) return MEDIUM;
  return HIGH;
}
