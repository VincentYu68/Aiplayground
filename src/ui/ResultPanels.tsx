/**
 * Everything the model has to say about itself: how close it got to the photo,
 * how well it will hold together, what it costs in parts, and how to get it
 * out of the browser.
 */

import { useMemo, useState } from 'react';
import { bufferToDataUrl, downloadText } from '../lib/loadImage';
import { partsListToBricklinkXml, partsListToCsv } from '../core/export/bom';
import { toLdraw } from '../core/export/ldraw';
import { toPrintableManual } from '../core/export/manual';
import { baseplateFor } from '../core/lego/catalog';
import { PLATE_MM, STUD_MM } from '../core/lego/units';
import type { BuildResult } from '../types';
import type { SourceImage } from '../lib/loadImage';

export function FidelityPanel({ result, source }: { result: BuildResult; source: SourceImage }) {
  // One preview pixel is a stud wide and a plate tall, so it has to be drawn
  // with the same 8 : 3.2 ratio the real bricks have.
  const previewUrl = useMemo(
    () =>
      bufferToDataUrl(
        result.fidelity.preview.rgba,
        result.fidelity.preview.width,
        result.fidelity.preview.height,
        STUD_MM,
        PLATE_MM,
      ),
    [result],
  );

  const iou = Math.round(result.fidelity.silhouetteIoU * 100);
  const deltaE = result.fidelity.meanDeltaE;
  const colourVerdict =
    deltaE < 5 ? 'very close' : deltaE < 10 ? 'close' : deltaE < 18 ? 'recognisable' : 'loose';
  const shape = describeShape(result.viewsUsed);

  return (
    <section className="panel">
      <h2>How close is it?</h2>
      <div className="compare">
        <figure>
          <img src={source.dataUrl} alt="Source photo" />
          <figcaption>Photo</figcaption>
        </figure>
        <figure>
          <img src={previewUrl} alt="Model seen from the front" className="pixelated" />
          <figcaption>Model, front on</figcaption>
        </figure>
      </div>
      <dl className="metrics">
        <div>
          <dt>Silhouette match</dt>
          <dd>{iou}%</dd>
          <p>
            Overlap between the model's outline and the object's, <em>in the photo
            you framed</em>. It says nothing about the shape side-on — a flat slab
            scores full marks here.
          </p>
        </div>
        <div>
          <dt>Shape</dt>
          <dd>{shape.headline}</dd>
          <p>{shape.detail}</p>
        </div>
        <div>
          <dt>Colour error</dt>
          <dd>
            ΔE {deltaE.toFixed(1)} <span className="verdict">{colourVerdict}</span>
          </dd>
          <p>Average perceptual distance from the photo to the nearest LEGO colour.</p>
        </div>
      </dl>
    </section>
  );
}

/**
 * What the geometry is actually worth.
 *
 * The silhouette number sits right next to this and routinely reads 97% while
 * the solid behind it is less than half right, because matching the outline of
 * the one photo you were given is not evidence about depth. The figures quoted
 * here are mean 3D IoU against known solids from bench/run3d.ts, so the panel
 * reports the shape's accuracy rather than implying it from the outline's.
 */
function describeShape(views: number): { headline: string; detail: string } {
  if (views <= 1) {
    return {
      headline: 'Guessed',
      detail:
        'One photo cannot show depth, so the model assumes the object is about as deep as it is wide. Against known solids that recovers roughly half the true volume. A second photo from the side takes it to about 71%.',
    };
  }
  if (views === 2) {
    return {
      headline: 'Carved from 2 views',
      detail:
        'The shape is the intersection of both outlines — a real solid, about 71% of the true volume on the benchmark. Two more angles take it to roughly 77%.',
    };
  }
  return {
    headline: `Carved from ${views} views`,
    detail:
      'About 77% of the true volume on the benchmark. What silhouettes can never recover is hollows nothing sees — the inside of a mug — and the space trapped between parts that stick out, like a spout and a handle.',
  };
}

export function StabilityPanel({ result }: { result: BuildResult }) {
  const [showIssues, setShowIssues] = useState(false);
  const s = result.stability;
  const tone = s.score >= 85 ? 'good' : s.score >= 65 ? 'ok' : 'poor';
  const plate = baseplateFor(result.gridX, result.gridZ);

  return (
    <section className="panel">
      <h2>Will it hold together?</h2>
      <div className={`score ${tone}`}>
        <b>{s.score}</b>
        <span>/ 100</span>
      </div>
      <ul className="facts-list">
        <li>
          <span>Assembly</span>
          <b>
            {s.grounded
              ? 'One connected piece, resting on the ground'
              : `${s.assemblies} separate sections — needs a baseplate`}
          </b>
        </li>
        <li>
          <span>Staggered joints</span>
          <b>{Math.round((1 - s.seamAlignment) * 100)}% offset from the course below</b>
        </li>
        <li>
          <span>Average anchoring</span>
          <b>{s.averageStudsBelow.toFixed(1)} studs per part</b>
        </li>
        <li>
          <span>Supports added</span>
          <b>{s.supportsAdded}</b>
        </li>
        {s.cantilevered > 0 && (
          <li>
            <span>Held from above</span>
            <b>{s.cantilevered} parts</b>
          </li>
        )}
        {s.removedFragments > 0 && (
          <li>
            <span>Loose fragments removed</span>
            <b>{s.removedFragments}</b>
          </li>
        )}
        {plate && (
          <li>
            <span>Recommended base</span>
            <b>
              {plate.name} ({plate.code})
            </b>
          </li>
        )}
      </ul>

      {s.issues.length > 0 && (
        <>
          <button type="button" className="link-button" onClick={() => setShowIssues((v) => !v)}>
            {showIssues ? 'Hide' : 'Show'} {s.issues.length} note{s.issues.length === 1 ? '' : 's'}
          </button>
          {showIssues && (
            <ul className="issues">
              {s.issues.map((issue, i) => (
                <li key={i} className={issue.kind}>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function PartsPanel({ result }: { result: BuildResult }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? result.partsList : result.partsList.slice(0, 12);

  return (
    <section className="panel">
      <h2>
        Parts <span className="count">{result.totalParts}</span>
      </h2>
      <table className="parts-table">
        <thead>
          <tr>
            <th>Colour</th>
            <th>Part</th>
            <th className="num">Qty</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={`${e.partId}-${e.colorLdraw}`}>
              <td>
                <span className="swatch" style={{ background: e.colorHex }} />
                {e.colorName}
              </td>
              <td>
                {e.name} <code>{e.code}</code>
              </td>
              <td className="num">{e.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.partsList.length > 12 && (
        <button type="button" className="link-button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${result.partsList.length} lines`}
        </button>
      )}
    </section>
  );
}

export function ExportPanel({ result, name }: { result: BuildResult; name: string }) {
  const safe = name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'model';

  return (
    <section className="panel">
      <h2>Take it with you</h2>
      <div className="export-grid">
        <button
          type="button"
          onClick={() => downloadText(`${safe}.ldr`, toLdraw(result.steps, { modelName: name }))}
        >
          LDraw model
          <em>Opens in Studio, LeoCAD, LDView — build steps included</em>
        </button>
        <button
          type="button"
          onClick={() => downloadText(`${safe}-instructions.html`, toPrintableManual(result, name), 'text/html')}
        >
          Printable manual
          <em>Plan view of every step, ready to print</em>
        </button>
        <button
          type="button"
          onClick={() => downloadText(`${safe}-parts.csv`, partsListToCsv(result.partsList), 'text/csv')}
        >
          Parts list (CSV)
          <em>Spreadsheet of every element and colour</em>
        </button>
        <button
          type="button"
          onClick={() =>
            downloadText(
              `${safe}-bricklink.xml`,
              partsListToBricklinkXml(result.partsList),
              'application/xml',
            )
          }
        >
          Bricklink wanted list
          <em>Mass-upload XML to price or buy the build</em>
        </button>
      </div>
    </section>
  );
}
