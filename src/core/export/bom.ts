/**
 * Bill of materials.
 *
 * Aggregated by element and colour, which is exactly how Bricklink and
 * Pick-a-Brick want it, so the list can be used to actually buy the model.
 */

import { COLOR_BY_LDRAW } from '../lego/colors';
import { ALL_PARTS } from '../lego/catalog';
import type { PartsListEntry, Placement } from '../../types';

const PART_BY_ID = new Map(ALL_PARTS.map((p) => [p.id, p]));

export function buildPartsList(placements: Placement[]): PartsListEntry[] {
  const counts = new Map<string, PartsListEntry>();
  for (const p of placements) {
    const key = `${p.partId}|${p.color}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    const def = PART_BY_ID.get(p.partId);
    const color = COLOR_BY_LDRAW.get(p.color);
    counts.set(key, {
      partId: p.partId,
      code: p.code,
      name: def?.name ?? p.partId,
      colorLdraw: p.color,
      colorName: color?.name ?? `LDraw ${p.color}`,
      colorHex: color?.hex ?? '#888888',
      count: 1,
    });
  }

  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.colorName.localeCompare(b.colorName),
  );
}

export function partsListToCsv(entries: PartsListEntry[]): string {
  const rows = [['Part', 'Element ID', 'Colour', 'LDraw colour', 'Quantity'].join(',')];
  for (const e of entries) {
    rows.push([`"${e.name}"`, e.code, `"${e.colorName}"`, String(e.colorLdraw), String(e.count)].join(','));
  }
  return rows.join('\n');
}

/**
 * Bricklink's "Mass Upload" XML — paste this into Bricklink to price or buy the
 * whole model in one go.
 */
export function partsListToBricklinkXml(entries: PartsListEntry[]): string {
  const items = entries
    .map(
      (e) =>
        `  <ITEM>\n    <ITEMTYPE>P</ITEMTYPE>\n    <ITEMID>${e.code}</ITEMID>\n    <COLOR>${bricklinkColorId(
          e.colorLdraw,
        )}</COLOR>\n    <MINQTY>${e.count}</MINQTY>\n  </ITEM>`,
    )
    .join('\n');
  return `<INVENTORY>\n${items}\n</INVENTORY>`;
}

/**
 * LDraw colour code -> Bricklink colour id for the palette in use. Bricklink
 * uses its own numbering, so an explicit table is the only correct option.
 */
const BRICKLINK_COLOR: Record<number, number> = {
  0: 11, // Black
  308: 120, // Dark Brown
  70: 88, // Reddish Brown
  84: 150, // Medium Nougat
  92: 28, // Nougat / Flesh
  78: 90, // Light Nougat
  28: 69, // Dark Tan
  19: 2, // Tan
  15: 1, // White
  503: 99, // Very Light Bluish Gray
  71: 86, // Light Bluish Gray
  72: 85, // Dark Bluish Gray
  320: 59, // Dark Red
  216: 27, // Rust
  4: 5, // Red
  484: 68, // Dark Orange
  25: 4, // Orange
  191: 110, // Bright Light Orange
  14: 3, // Yellow
  226: 103, // Bright Light Yellow
  27: 34, // Lime
  326: 158, // Yellowish Green
  10: 36, // Bright Green
  2: 6, // Green
  288: 80, // Dark Green
  330: 155, // Olive Green
  378: 48, // Sand Green
  323: 152, // Light Aqua
  322: 156, // Medium Azure
  321: 153, // Dark Azure
  212: 105, // Bright Light Blue
  73: 42, // Medium Blue
  1: 7, // Blue
  272: 63, // Dark Blue
  379: 55, // Sand Blue
  85: 89, // Dark Purple
  22: 24, // Purple
  26: 71, // Magenta
  5: 47, // Dark Pink
  29: 104, // Bright Pink
  13: 23, // Pink
};

function bricklinkColorId(ldraw: number): number {
  return BRICKLINK_COLOR[ldraw] ?? 0;
}

export function totalParts(entries: PartsListEntry[]): number {
  return entries.reduce((n, e) => n + e.count, 0);
}
