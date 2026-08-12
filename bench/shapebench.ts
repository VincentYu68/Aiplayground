/**
 * Does the model look like the object?
 *
 *   npx vite-node bench/photos3d.ts            render the corpus first
 *   npx vite-node bench/shapebench.ts          then score it
 *   npx vite-node bench/shapebench.ts --only car
 *   npx vite-node bench/shapebench.ts --baseline bench/out/corpus/scores.tsv
 *
 * The headline the app shows a user is silhouette IoU against the photograph it
 * was given. A flat extrusion of that photograph scores in the high nineties on
 * it by construction, while looking like a loaf from every other angle — so
 * that number cannot fail, and a metric that cannot fail is not measuring
 * anything. It is still reported here, clearly labelled front-view-only, next
 * to the two numbers that can:
 *
 *   solid IoU     against the true voxelised object, in a frame where both are
 *                 one unit tall and neither is rescaled to fit the other
 *   unseen        mean silhouette agreement over four angles the pipeline never
 *                 saw — side, top, iso, rear three-quarter
 *
 * Depth comes from the real weights through the app's own `monodepth.ts`, not
 * from the fallback bulge, so this measures the algorithm that actually ships.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateModel } from '../src/core/build/pipeline';
import { DEFAULT_OPTIONS, type BuildResult } from '../src/types';
import { CORPUS, type CorpusObject, type Shot } from './corpus/objects';
import {
  align,
  extentOf,
  makeLattice,
  modelOccupancy,
  shifted,
  silhouette,
  silhouetteIoU,
  truthExtent,
  truthOccupancy,
  VIEWS,
} from './corpus/frame';
import { depthWeights, reliefFor } from './corpus/relief';
import { decodePng } from './png';

const CORPUS_DIR = resolve(process.env.CORPUS_OUT ?? 'bench/out/corpus');

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

interface Row {
  object: string;
  shot: string;
  /** Front-view silhouette IoU, which is the number the app reports. */
  front: number;
  /** Mean agreement over the four angles the pipeline never saw. */
  unseen: number;
  /** Per-view agreement, in `VIEWS` order. */
  views: number[];
  solidIoU: number;
  missed: number;
  invented: number;
  /** Model depth over true depth. 1.00 is right; 2.9 is the loaf. */
  depthRatio: number;
  widthRatio: number;
  parts: number;
  /** What the pipeline itself claims, for comparison with what is true. */
  claimedIoU: number;
  failure: string | null;
}

function loadShot(object: CorpusObject, shot: Shot) {
  const label = `${object.name}-${shot.name}`;
  const photoFile = join(CORPUS_DIR, `${label}.png`);
  const maskFile = join(CORPUS_DIR, `${label}-mask.png`);
  if (!existsSync(photoFile) || !existsSync(maskFile)) {
    throw new Error(`${label}: no render — run "npx vite-node bench/photos3d.ts" first`);
  }
  const photo = decodePng(readFileSync(photoFile));
  const rendered = decodePng(readFileSync(maskFile));
  const mask = new Uint8Array(photo.width * photo.height);
  for (let i = 0; i < mask.length; i++) mask[i] = rendered.rgba[i * 4] >= 128 ? 1 : 0;
  return { label, photo, mask };
}

/**
 * Score one photograph.
 *
 * The cut-out handed to the pipeline is the exact one from the renderer, not a
 * segmentation of the photograph. That is deliberate: this bench is about the
 * shape behind the outline, and mixing in the segmenter's errors would make a
 * geometry regression indistinguishable from a segmentation regression.
 * `bench/run.ts` is where the segmenter is scored.
 */
async function scoreShot(object: CorpusObject, shot: Shot): Promise<Row> {
  const { photo, mask } = loadShot(object, shot);
  const relief = await reliefFor(photo.rgba, photo.width, photo.height);

  const view = {
    rgba: photo.rgba,
    mask,
    width: photo.width,
    height: photo.height,
    azimuth: 0,
    relief,
  };
  // Hollowing removes interior the true solid has, and would read as a huge
  // miss against a solid object. The shape is what is being measured, not the
  // parts-saving pass.
  const result: BuildResult = generateModel([view], { ...DEFAULT_OPTIONS, hollow: false });

  const truthSize = truthExtent(object.parts, shot.azimuth);
  const plate = 1 / result.gridY;
  const stud = plate * 2.5;
  const modelHalfX = (result.gridX * stud) / 2;
  const modelHalfZ = (result.gridZ * stud) / 2;
  // The lattice has to hold whichever is bigger. Clipping the model to the
  // object's own extent would quietly delete exactly the error worth seeing.
  const lattice = makeLattice(
    Math.max(truthSize.width / 2, modelHalfX) + 0.05,
    Math.max(truthSize.depth / 2, modelHalfZ) + 0.05,
    1.04,
  );

  const truth = truthOccupancy(object.parts, shot.azimuth, lattice);
  const model = modelOccupancy(result, lattice);
  const alignment = align(truth, model);
  const placed = shifted(model, alignment.offset);

  const views = VIEWS.map((v) =>
    silhouetteIoU(silhouette(truth, v.azimuth, v.elevation), silhouette(placed, v.azimuth, v.elevation)),
  );
  const unseen = VIEWS.map((v, i) => (v.seen ? null : views[i])).filter(
    (x): x is number => x !== null,
  );

  const modelSize = extentOf(placed);
  return {
    object: object.name,
    shot: shot.name,
    front: views[0],
    unseen: unseen.reduce((a, b) => a + b, 0) / unseen.length,
    views,
    solidIoU: alignment.iou,
    missed: alignment.missed,
    invented: alignment.invented,
    depthRatio: truthSize.depth > 0 ? modelSize.depth / truthSize.depth : 0,
    widthRatio: truthSize.width > 0 ? modelSize.width / truthSize.width : 0,
    parts: result.totalParts,
    claimedIoU: result.fidelity.silhouetteIoU,
    failure: null,
  };
}

function pct(v: number): string {
  return (v * 100).toFixed(1);
}

function table(rows: Row[]): string {
  const lines: string[] = [];
  lines.push(
    'object    shot     solid  unseen   front | side   top   iso  rear3q | depth  width  missed invent parts',
  );
  lines.push('-'.repeat(103));
  for (const r of rows) {
    if (r.failure) {
      lines.push(`${r.object.padEnd(9)} ${r.shot.padEnd(8)} FAILED: ${r.failure}`);
      continue;
    }
    lines.push(
      `${r.object.padEnd(9)} ${r.shot.padEnd(8)}` +
        `${pct(r.solidIoU).padStart(5)} ${pct(r.unseen).padStart(6)}  ${pct(r.front).padStart(6)} |` +
        `${pct(r.views[1]).padStart(6)}${pct(r.views[2]).padStart(6)}${pct(r.views[3]).padStart(6)}` +
        `${pct(r.views[4]).padStart(8)} |` +
        `${r.depthRatio.toFixed(2).padStart(6)}${r.widthRatio.toFixed(2).padStart(7)}` +
        `${pct(r.missed).padStart(8)}${pct(r.invented).padStart(7)}${String(r.parts).padStart(6)}`,
    );
  }
  const scored = rows.filter((r) => !r.failure);
  if (scored.length > 1) {
    const mean = (pick: (r: Row) => number) =>
      scored.reduce((a, r) => a + pick(r), 0) / scored.length;
    lines.push('-'.repeat(103));
    lines.push(
      `${'mean'.padEnd(18)}${pct(mean((r) => r.solidIoU)).padStart(5)} ` +
        `${pct(mean((r) => r.unseen)).padStart(6)}  ${pct(mean((r) => r.front)).padStart(6)} |` +
        `${pct(mean((r) => r.views[1])).padStart(6)}${pct(mean((r) => r.views[2])).padStart(6)}` +
        `${pct(mean((r) => r.views[3])).padStart(6)}${pct(mean((r) => r.views[4])).padStart(8)} |` +
        `${mean((r) => r.depthRatio).toFixed(2).padStart(6)}${mean((r) => r.widthRatio).toFixed(2).padStart(7)}`,
    );
  }
  return lines.join('\n');
}

/** One line per shot, stable columns, so two runs diff cleanly. */
function tsv(rows: Row[]): string {
  const head = [
    'object',
    'shot',
    'solidIoU',
    'unseen',
    'front',
    ...VIEWS.slice(1).map((v) => v.name),
    'depthRatio',
    'widthRatio',
    'missed',
    'invented',
    'parts',
    'claimedFrontIoU',
    'failure',
  ].join('\t');
  const body = rows.map((r) =>
    r.failure
      ? [r.object, r.shot, ...Array(11).fill(''), r.failure].join('\t')
      : [
          r.object,
          r.shot,
          r.solidIoU.toFixed(4),
          r.unseen.toFixed(4),
          r.front.toFixed(4),
          ...r.views.slice(1).map((v) => v.toFixed(4)),
          r.depthRatio.toFixed(3),
          r.widthRatio.toFixed(3),
          r.missed.toFixed(4),
          r.invented.toFixed(4),
          String(r.parts),
          r.claimedIoU.toFixed(4),
          '',
        ].join('\t'),
  );
  return [head, ...body].join('\n');
}

/** What moved since a previous run, so a change can be judged rather than admired. */
function diff(rows: Row[], baselineFile: string): string {
  const lines = readFileSync(baselineFile, 'utf8').trim().split('\n');
  const head = lines[0].split('\t');
  const before = new Map<string, Record<string, string>>();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const record: Record<string, string> = {};
    head.forEach((h, i) => (record[h] = cells[i]));
    before.set(`${cells[0]}|${cells[1]}`, record);
  }
  const out = ['', `against ${baselineFile}`, 'object    shot        solid       unseen        front'];
  for (const r of rows) {
    const was = before.get(`${r.object}|${r.shot}`);
    if (!was || r.failure) continue;
    const move = (now: number, then: string) => {
      const delta = now - Number(then);
      const sign = delta >= 0 ? '+' : '';
      return `${pct(now).padStart(5)} (${sign}${(delta * 100).toFixed(1)})`.padStart(13);
    };
    out.push(
      `${r.object.padEnd(9)} ${r.shot.padEnd(8)}${move(r.solidIoU, was.solidIoU)}` +
        `${move(r.unseen, was.unseen)}${move(r.front, was.front)}`,
    );
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const only = option('only');
  const objects = only ? CORPUS.filter((o) => only.split(',').includes(o.name)) : CORPUS;
  if (objects.length === 0) throw new Error(`no corpus object matched ${only}`);

  const rows: Row[] = [];
  for (const object of objects) {
    for (const shot of object.shots) {
      // One bad photograph must not take the rest of the corpus with it. The
      // old screenshot harness died on the second image and silently reported
      // whatever it had managed before that.
      try {
        rows.push(await scoreShot(object, shot));
      } catch (error) {
        rows.push({
          object: object.name,
          shot: shot.name,
          front: 0,
          unseen: 0,
          views: VIEWS.map(() => 0),
          solidIoU: 0,
          missed: 1,
          invented: 0,
          depthRatio: 0,
          widthRatio: 0,
          parts: 0,
          claimedIoU: 0,
          failure: String(error).split('\n')[0],
        });
      }
      process.stderr.write(`  ${object.name}-${shot.name} done\n`);
    }
  }

  console.log(`\ndepth weights: ${depthWeights() ?? 'none — fallback bulge'}`);
  console.log(`corpus: rendered 3D with exact ground truth (bench/corpus)\n`);
  console.log(table(rows));
  console.log(
    '\nsolid  = 3D IoU against the true voxelised object, aligned but not rescaled' +
      '\nunseen = mean silhouette agreement over four angles the pipeline never saw' +
      '\nfront  = silhouette agreement on the one view it was given, which an' +
      '\n         extrusion reproduces by construction — it cannot fail, so it is' +
      '\n         reported apart from the rest rather than averaged into them' +
      '\ndepth  = model depth / true depth. 1.00 is right; 3 is a loaf',
  );

  mkdirSync(CORPUS_DIR, { recursive: true });
  const out = join(CORPUS_DIR, 'scores.tsv');
  const baseline = option('baseline');
  if (baseline && existsSync(baseline)) console.log(diff(rows, baseline));
  writeFileSync(out, `${tsv(rows)}\n`);
  console.log(`\nscores written to ${out}`);

  const failed = rows.filter((r) => r.failure);
  if (failed.length) {
    console.error(`\n${failed.length} of ${rows.length} shots failed to score`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
