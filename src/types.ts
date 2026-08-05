import type { PartHeight } from './core/lego/catalog';

/** How the flat photo is lifted into a solid. */
export type SolidMode = 'relief' | 'symmetric' | 'revolve';

/** Vertical resolution of the build. */
export type BuildResolution = 'bricks' | 'mixed';

export interface BuildOptions {
  /** Width of the finished model in studs. Everything else scales from this. */
  studsWide: number;
  /** Peak thickness as a fraction of the model's width. */
  depthScale: number;
  solidMode: SolidMode;
  resolution: BuildResolution;
  /** Cap on distinct colours; the palette is reduced to fit. 0 = no cap. */
  maxColors: number;
  /** Blend of shading-derived depth vs. the geometric bulge profile, 0..1. */
  shadingInfluence: number;
  /** Carve out the interior to save parts once the model is thick enough. */
  hollow: boolean;
  /** Target number of parts placed per manual step. */
  partsPerStep: number;
  /** Deterministic seed for the tiler's randomised restarts. */
  seed: number;
}

export const DEFAULT_OPTIONS: BuildOptions = {
  studsWide: 32,
  depthScale: 0.55,
  solidMode: 'symmetric',
  // Course-aligned bricks by default: on a curved surface, plate-level layers
  // produce one-plate rings that overhang whatever is under them, which roughly
  // doubles the part count and halves the stability score for detail you can
  // barely see. Detail is opt-in, and the report says what it costs.
  resolution: 'bricks',
  maxColors: 12,
  shadingInfluence: 0.25,
  hollow: true,
  partsPerStep: 8,
  seed: 12345,
};

/** A single element placed in the model. */
export interface Placement {
  /** Catalogue part id, e.g. "brick-2x4". */
  partId: string;
  code: string;
  /** Footprint as placed: w along X, d along Z. */
  w: number;
  d: number;
  height: PartHeight;
  /** Minimum corner, in grid coordinates. y counts plate layers from the ground. */
  x: number;
  y: number;
  z: number;
  /** LDraw colour code. */
  color: number;
  /** True when the tiler added this purely to hold something else up. */
  support?: boolean;
  /**
   * True when nothing sits under this part and it is instead clamped by the
   * course above. Perfectly solid once built, but the builder has to hold it
   * in place for a moment, so the manual calls it out.
   */
  needsHold?: boolean;
}

export interface BuildStep {
  index: number;
  /** Which 3-plate course this step belongs to. */
  course: number;
  placements: Placement[];
  /** Running total including this step. */
  cumulativeParts: number;
}

export interface StabilityIssue {
  kind: 'floating' | 'weak-connection' | 'overhang' | 'aligned-seams' | 'held-above';
  message: string;
  /** Grid position the issue refers to, for highlighting in the viewer. */
  at?: { x: number; y: number; z: number };
}

export interface StabilityReport {
  /** 0-100. */
  score: number;
  grounded: boolean;
  supportsAdded: number;
  removedFragments: number;
  weakConnections: number;
  /** Parts with nothing underneath that are locked in by the course above. */
  cantilevered: number;
  /** Separate rigid assemblies; anything above 1 needs a baseplate to join. */
  assemblies: number;
  /** Studs repainted to tie otherwise-separate halves of the model together. */
  tiesRecoloured: number;
  /** Fraction of course boundaries whose seams line up (lower is stronger). */
  seamAlignment: number;
  averageStudsBelow: number;
  issues: StabilityIssue[];
}

export interface FidelityReport {
  /** Silhouette intersection-over-union against the source mask, 0..1. */
  silhouetteIoU: number;
  /** Mean CIEDE2000 error of the quantised colours. */
  meanDeltaE: number;
  /** Front-facing render of the model, one pixel per (stud, plate). */
  preview: { width: number; height: number; rgba: Uint8ClampedArray };
}

export interface PartsListEntry {
  partId: string;
  code: string;
  name: string;
  colorLdraw: number;
  colorName: string;
  colorHex: string;
  count: number;
}

export interface BuildResult {
  options: BuildOptions;
  gridX: number;
  gridY: number;
  gridZ: number;
  placements: Placement[];
  steps: BuildStep[];
  stability: StabilityReport;
  fidelity: FidelityReport;
  partsList: PartsListEntry[];
  totalParts: number;
  dimensionsMM: { width: number; height: number; depth: number };
  /** Wall-clock time of the generation pass. */
  elapsedMs: number;
}

/** Message contract with the pipeline worker. */
export interface WorkerRequest {
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  mask: Uint8Array;
  options: BuildOptions;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; stage: string; fraction: number }
  | { id: number; type: 'done'; result: BuildResult }
  | { id: number; type: 'error'; message: string };
