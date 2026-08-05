/**
 * Printable manual.
 *
 * The 3D viewer is the primary manual, but a paper version is genuinely useful
 * at the table, so each step is also drawn as a top-down plan of its layer:
 * parts already in place are ghosted, the parts to add this step are drawn in
 * full colour with a heavy outline, exactly like the plan views in a real
 * instruction booklet.
 *
 * Output is a single self-contained HTML file with inline SVG — no assets, no
 * fonts to load, prints correctly from any browser.
 */

import { COLOR_BY_LDRAW } from '../lego/colors';
import type { BuildResult, Placement } from '../../types';

const CELL = 14;
const PAD = 10;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function colorHex(ldraw: number): string {
  return COLOR_BY_LDRAW.get(ldraw)?.hex ?? '#999999';
}

function contrastInk(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? '#111' : '#fff';
}

function drawPart(p: Placement, opts: { ghost: boolean }): string {
  const x = PAD + p.x * CELL;
  const y = PAD + p.z * CELL;
  const w = p.w * CELL;
  const h = p.d * CELL;
  const fill = colorHex(p.color);
  if (opts.ghost) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" fill-opacity="0.18" stroke="#bbb" stroke-width="0.5"/>`;
  }
  const studs: string[] = [];
  for (let dz = 0; dz < p.d; dz++) {
    for (let dx = 0; dx < p.w; dx++) {
      studs.push(
        `<circle cx="${x + dx * CELL + CELL / 2}" cy="${y + dz * CELL + CELL / 2}" r="${CELL * 0.26}" fill="none" stroke="${contrastInk(
          fill,
        )}" stroke-opacity="0.45" stroke-width="1"/>`,
      );
    }
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111" stroke-width="1.6" rx="1.5"/>${studs.join(
    '',
  )}`;
}

function stepPlan(result: BuildResult, stepIndex: number): string {
  const step = result.steps[stepIndex];
  const layerY = step.placements[0]?.y ?? 0;

  // Everything already standing that shows up on this layer.
  const priorOnLayer: Placement[] = [];
  for (let i = 0; i < stepIndex; i++) {
    for (const p of result.steps[i].placements) {
      if (p.y <= layerY && p.y + p.height > layerY) priorOnLayer.push(p);
    }
  }

  const width = PAD * 2 + result.gridX * CELL;
  const height = PAD * 2 + result.gridZ * CELL;
  const body = [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#fafafa" stroke="#e4e4e4"/>`,
    ...priorOnLayer.map((p) => drawPart(p, { ghost: true })),
    ...step.placements.map((p) => drawPart(p, { ghost: false })),
  ].join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Step ${
    stepIndex + 1
  } plan view">${body}</svg>`;
}

function stepPartSummary(step: BuildResult['steps'][number]): string {
  const counts = new Map<string, { label: string; hex: string; n: number }>();
  for (const p of step.placements) {
    const hex = colorHex(p.color);
    const key = `${p.partId}|${p.color}`;
    const existing = counts.get(key);
    if (existing) existing.n++;
    else {
      const kind = p.height === 3 ? 'Brick' : 'Plate';
      counts.set(key, { label: `${kind} ${p.w}x${p.d}`, hex, n: 1 });
    }
  }
  return [...counts.values()]
    .map(
      (c) =>
        `<li><span class="swatch" style="background:${c.hex}"></span>${c.n} &times; ${escapeHtml(
          c.label,
        )}</li>`,
    )
    .join('');
}

export function toPrintableManual(result: BuildResult, title = 'Brickify model'): string {
  const steps = result.steps
    .map(
      (step, i) => `
      <section class="step">
        <header>
          <h2>Step ${i + 1}<span class="of"> / ${result.steps.length}</span></h2>
          <p class="meta">Layer ${step.placements[0]?.y ?? 0} &middot; ${step.placements.length} part${
            step.placements.length === 1 ? '' : 's'
          } &middot; ${step.cumulativeParts} placed so far</p>
        </header>
        <div class="row">
          <div class="plan">${stepPlan(result, i)}</div>
          <div>
            <ul class="parts">${stepPartSummary(step)}</ul>
            ${
              step.placements.some((p) => p.needsHold)
                ? '<p class="note">Some of these overhang with nothing underneath — hold them in place until the next course locks them in.</p>'
                : ''
            }
          </div>
        </div>
      </section>`,
    )
    .join('');

  const bom = result.partsList
    .map(
      (e) =>
        `<tr><td><span class="swatch" style="background:${e.colorHex}"></span>${escapeHtml(
          e.colorName,
        )}</td><td>${escapeHtml(e.name)}</td><td>${e.code}</td><td class="num">${e.count}</td></tr>`,
    )
    .join('');

  const dims = result.dimensionsMM;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — building instructions</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px; color: #14161a; background: #fff; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .lede { color: #5a6069; margin: 0 0 24px; }
  .facts { display: flex; flex-wrap: wrap; gap: 20px; padding: 14px 18px; background: #f5f6f8; border-radius: 10px; margin-bottom: 28px; }
  .facts div { font-size: 13px; color: #5a6069; }
  .facts strong { display: block; font-size: 17px; color: #14161a; }
  .step { break-inside: avoid; page-break-inside: avoid; border-top: 1px solid #e6e8eb; padding: 18px 0; }
  .step h2 { font-size: 18px; margin: 0; display: inline-block; }
  .of { color: #9aa0a6; font-weight: 400; }
  .meta { margin: 2px 0 12px; font-size: 13px; color: #7a808a; }
  .row { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
  .plan svg { max-width: 100%; height: auto; }
  ul.parts { list-style: none; margin: 0; padding: 0; font-size: 14px; }
  ul.parts li { margin-bottom: 4px; }
  .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid rgba(0,0,0,.25); margin-right: 7px; vertical-align: -1px; }
  .note { font-size: 12.5px; color: #8a5a00; border-left: 2px solid #f0b429; padding-left: 9px; margin: 10px 0 0; max-width: 42ch; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eceef1; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #7a808a; }
  td.num, th.num { text-align: right; }
  @media print { body { padding: 0; } .step { padding: 12px 0; } }
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="lede">Building instructions generated by Brickify. Standard LEGO bricks and plates only.</p>
  <div class="facts">
    <div>Parts<strong>${result.totalParts}</strong></div>
    <div>Steps<strong>${result.steps.length}</strong></div>
    <div>Size<strong>${result.gridX} &times; ${result.gridZ} studs, ${result.gridY} plates</strong></div>
    <div>Finished<strong>${Math.round(dims.width)} &times; ${Math.round(dims.depth)} &times; ${Math.round(
      dims.height,
    )} mm</strong></div>
    <div>Stability<strong>${result.stability.score}/100</strong></div>
    <div>Silhouette match<strong>${Math.round(result.fidelity.silhouetteIoU * 100)}%</strong></div>
  </div>
  <h2>Parts needed</h2>
  <table><thead><tr><th>Colour</th><th>Part</th><th>Element</th><th class="num">Qty</th></tr></thead><tbody>${bom}</tbody></table>
  <h2 style="margin-top:32px">Assembly</h2>
  ${steps}
</body></html>`;
}
