import type { PartHeight } from './core/lego/catalog';

/** How the flat photo is lifted into a solid. */
export type SolidMode = 'relief' | 'symmetric' | 'revolve';

/**
 * What to do with the side of the object the photograph never saw.
 *
 * 'wrap'   carry the colours at the silhouette round to the back
 * 'flat'   one plain colour for the whole far side
 * 'mirror' repeat the front, which is almost always wrong
 */
export type BackTreatment = 'wrap' | 'flat' | 'mirror';

/** Vertical resolution of the build. */
export type BuildResolution = 'bricks' | 'mixed';

export interface BuildOptions {
  /** Width of the finished model in studs. Everything else scales from this. */
  studsWide: number;
  /** Peak thickness as a fraction of the model's width. */
  depthScale: number;
  solidMode: SolidMode;
  /** How the unseen far side of the object is coloured. */
  backTreatment: BackTreatment;
  resolution: BuildResolution;
  /** Cap on distinct colours; the palette is reduced to fit. 0 = no cap. */
  maxColors: number;
  /** Blend of shading-derived depth vs. the geometric bulge profile, 0..1. */
  shadingInfluence: number;
  /** Carve out the interior to save parts once the model is thick enough. */
  hollow: boolean;
  /** Target number of parts placed per manual step. */
  partsPerStep: number;
  /**
   * Views a voxel may be absent from and still survive the carve. 0 is the
   * strict silhouette intersection; 1 keeps the model whole when one cut-out
   * clips a limb.
   */
  hullTolerance: number;
  /** Deterministic seed for the tiler's randomised restarts. */
  seed: number;
}

export const DEFAULT_OPTIONS: BuildOptions = {
  studsWide: 32,
  // "As deep as it is wide": assume a roughly circular cross-section. One
  // photograph cannot show depth, so this is a prior, and it is the best fixed
  // prior available — measured against known solids in bench/run3d.ts, mean 3D
  // IoU by this value is 40.9% at 0.4, 43.8% at 0.55 (the old default), 51.9%
  // at 0.85 and 53.0% at 1.0. The old value made everything about half as deep
  // as it should be, which is why single-view models read correctly head-on and
  // fell apart the moment you orbited them.
  depthScale: 1.0,
  solidMode: 'symmetric',
  // A photo says nothing about the far side. Wrapping the silhouette colours
  // round is a guess; mirroring the front is a confident fabrication, and a
  // recognisable one — a second face on the back of a head.
  backTreatment: 'wrap',
  // Course-aligned bricks by default: on a curved surface, plate-level layers
  // produce one-plate rings that overhang whatever is under them, which roughly
  // doubles the part count and halves the stability score for detail you can
  // barely see. Detail is opt-in, and the report says what it costs.
  resolution: 'bricks',
  maxColors: 12,
  shadingInfluence: 0.25,
  hollow: true,
  partsPerStep: 8,
  hullTolerance: 0,
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
  /** How many photographs went into the shape. */
  viewsUsed: number;
  /** Whether the shape was carved from silhouettes or guessed from one view. */
  geometry: 'visual-hull' | 'extruded';
  /**
   * Set when the requested width would have produced a model too tall to
   * build, and was reduced. Null when the width was used as asked for.
   */
  sizeLimited: { requested: number; used: number } | null;
  /** Wall-clock time of the generation pass. */
  elapsedMs: number;
}

/** Which segmenter produced a cut-out. */
export type SegmentEngine = 'sam' | 'grabcut';

/** A rectangle in image pixels. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One photograph, with everything needed to cut the object out of it. */
export interface ViewState {
  id: number;
  source: import('./lib/loadImage').SourceImage;
  /** Per-pixel brush hints: 0 none, 1 keep, 2 remove. */
  hints: Uint8Array;
  rect: Rect | null;
  mask: Uint8Array | null;
  /** Camera position in degrees around the object's vertical axis. */
  azimuth: number;
  /** Cut-out sensitivity for this photo; lighting differs between shots. */
  threshold: number;
  /** Which segmenter produced `mask`, so the UI can say. */
  engine: SegmentEngine | null;
}

/**
 * Message contract with the pipeline worker.
 *
 * Cutting the object out now costs about a second at full resolution — the
 * min-cut is not cheap — and it re-runs on every brush stroke, so it belongs
 * off the main thread just as much as the build does.
 */
export type WorkerRequest =
  | {
      /**
       * Where to fetch the segmentation model from. Sent once at startup; the
       * URLs come from the page because only the page knows where it is
       * deployed, and this app is mounted in a subdirectory.
       */
      kind: 'configure';
      urls: { runtime: string; encoder: string; decoder: string; classifier: string };
    }
  | {
      kind: 'build';
      id: number;
      views: Array<{
        rgba: Uint8ClampedArray;
        mask: Uint8Array;
        width: number;
        height: number;
        azimuth: number;
      }>;
      options: BuildOptions;
    }
  | {
      kind: 'segment';
      /** Which view this cut-out belongs to. */
      viewId: number;
      /** Bumped per request so a stale result can be dropped. */
      seq: number;
      rgba: Uint8ClampedArray;
      width: number;
      height: number;
      threshold: number;
      rect: Rect | null;
      hints: Uint8Array | null;
    };



export type WorkerResponse =
  | { id: number; type: 'progress'; stage: string; fraction: number }
  | { id: number; type: 'done'; result: BuildResult }
  | { id: number; type: 'error'; message: string }
  | {
      type: 'segmented';
      viewId: number;
      seq: number;
      mask: Uint8Array;
      engine: SegmentEngine;
      /** The box the cut-out actually used, so the editor can show it. */
      box: Rect | null;
    }
  | { type: 'segment-error'; viewId: number; seq: number; message: string }
  | {
      type: 'recognised';
      viewId: number;
      seq: number;
      label: string;
      confidence: number;
      prior: import('./core/recognise/shapePrior').ShapePrior | null;
    }
  | { type: 'model-progress'; loaded: number; total: number }
  | { type: 'model-ready' }
  // Not an error the user has to act on: the app keeps working on the old
  // segmenter, it is just less accurate.
  | { type: 'model-unavailable'; message: string };
