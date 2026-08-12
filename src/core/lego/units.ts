/**
 * Physical constants of the LEGO System in Play.
 *
 * Everything downstream is expressed in these units so that the generated model
 * has real-world proportions: a stud is wider than a plate is tall, which means
 * a voxel grid is *not* isotropic and has to be compensated for when we decide
 * how many layers tall a model should be.
 */

/** Centre-to-centre distance between two studs. */
export const STUD_MM = 8;
/** Height of one plate. */
export const PLATE_MM = 3.2;
/** Height of one brick — exactly three plates. */
export const BRICK_MM = 9.6;
/** Plates stacked to equal one stud of width. 8 / 3.2 = 2.5 */
export const PLATES_PER_STUD = STUD_MM / PLATE_MM;
/** A brick is three plates tall. */
export const PLATES_PER_BRICK = 3;

/** Actual moulded width of a 1x1 part — 0.2mm smaller than the grid pitch. */
export const PART_CLEARANCE_MM = 0.2;
export const STUD_DIAMETER_MM = 4.8;
export const STUD_HEIGHT_MM = 1.8;

/** LDraw uses "LDU"; 1 LDU = 0.4 mm. */
export const MM_PER_LDU = 0.4;
export const LDU_PER_STUD = STUD_MM / MM_PER_LDU; // 20
export const LDU_PER_PLATE = PLATE_MM / MM_PER_LDU; // 8

/**
 * Given a target width in studs and the aspect ratio of the source image,
 * work out how many *plate layers* tall the model must be to keep the
 * object's proportions.
 */
/**
 * Tallest model worth building, in plate layers — a little under 39cm.
 *
 * Lives here rather than in the pipeline because the UI has to quote the cap,
 * and quoting it from a second copy is how the panel came to say "Height is
 * capped at 165cm" underneath a pencil that was 165cm tall. The cap is a fixed
 * number; the model's height is not, and the two must not be confused.
 */
export const MAX_MODEL_PLATES = 120;

/** The cap expressed as a height, for anything that has to say it out loud. */
export const MAX_MODEL_HEIGHT_MM = MAX_MODEL_PLATES * PLATE_MM;

export function platesForAspect(studsWide: number, imageWidth: number, imageHeight: number): number {
  const physicalWidth = studsWide * STUD_MM;
  const physicalHeight = (physicalWidth * imageHeight) / imageWidth;
  return Math.max(1, Math.round(physicalHeight / PLATE_MM));
}

/** Human readable size of a finished model. */
export function modelDimensionsMM(studsX: number, plateLayers: number, studsZ: number) {
  return {
    width: studsX * STUD_MM,
    height: plateLayers * PLATE_MM,
    depth: studsZ * STUD_MM,
  };
}
