/**
 * A curated palette of solid LEGO colours that are widely produced in basic
 * bricks and plates, together with their official LDraw colour codes so the
 * exported .ldr file opens correctly in Stud.io / LeoCAD / Bricklink Studio.
 *
 * Only opaque solid colours are listed: transparent, chrome, glitter and
 * rubber materials are not available across the standard brick catalogue and
 * would make the bill of materials impossible to source.
 */

export interface LegoColor {
  /** Official LDraw colour code, used by the .ldr exporter. */
  ldraw: number;
  /** Bricklink-style colour name. */
  name: string;
  hex: string;
  rgb: [number, number, number];
  /** CIE L*a*b*, precomputed for perceptual matching. */
  lab: [number, number, number];
}

interface RawColor {
  ldraw: number;
  name: string;
  hex: string;
}

const RAW: RawColor[] = [
  { ldraw: 0, name: 'Black', hex: '05131D' },
  { ldraw: 308, name: 'Dark Brown', hex: '352100' },
  { ldraw: 70, name: 'Reddish Brown', hex: '582A12' },
  { ldraw: 84, name: 'Medium Nougat', hex: 'AA7D55' },
  { ldraw: 92, name: 'Nougat', hex: 'D09168' },
  { ldraw: 78, name: 'Light Nougat', hex: 'F6D7B3' },
  { ldraw: 28, name: 'Dark Tan', hex: '958A73' },
  { ldraw: 19, name: 'Tan', hex: 'E4CD9E' },
  { ldraw: 15, name: 'White', hex: 'FFFFFF' },
  { ldraw: 503, name: 'Very Light Bluish Gray', hex: 'E6E3E0' },
  { ldraw: 71, name: 'Light Bluish Gray', hex: 'A0A5A9' },
  { ldraw: 72, name: 'Dark Bluish Gray', hex: '6C6E68' },
  { ldraw: 320, name: 'Dark Red', hex: '720E0F' },
  { ldraw: 216, name: 'Rust', hex: 'B31004' },
  { ldraw: 4, name: 'Red', hex: 'C91A09' },
  { ldraw: 484, name: 'Dark Orange', hex: 'A95500' },
  { ldraw: 25, name: 'Orange', hex: 'FE8A18' },
  { ldraw: 191, name: 'Bright Light Orange', hex: 'FCAC00' },
  { ldraw: 14, name: 'Yellow', hex: 'F2CD37' },
  { ldraw: 226, name: 'Bright Light Yellow', hex: 'FFF03A' },
  { ldraw: 27, name: 'Lime', hex: 'BBE90B' },
  { ldraw: 326, name: 'Yellowish Green', hex: 'DFEEA5' },
  { ldraw: 10, name: 'Bright Green', hex: '4B9F4A' },
  { ldraw: 2, name: 'Green', hex: '237841' },
  { ldraw: 288, name: 'Dark Green', hex: '184632' },
  { ldraw: 330, name: 'Olive Green', hex: '77774E' },
  { ldraw: 378, name: 'Sand Green', hex: 'A0BCAC' },
  { ldraw: 323, name: 'Light Aqua', hex: 'ADC3C0' },
  { ldraw: 322, name: 'Medium Azure', hex: '36AEBF' },
  { ldraw: 321, name: 'Dark Azure', hex: '078BC9' },
  { ldraw: 212, name: 'Bright Light Blue', hex: '9DC3F7' },
  { ldraw: 73, name: 'Medium Blue', hex: '5A93DB' },
  { ldraw: 1, name: 'Blue', hex: '0055BF' },
  { ldraw: 272, name: 'Dark Blue', hex: '0A3463' },
  { ldraw: 379, name: 'Sand Blue', hex: '6074A1' },
  { ldraw: 85, name: 'Dark Purple', hex: '3F3691' },
  { ldraw: 22, name: 'Purple', hex: '81007B' },
  { ldraw: 26, name: 'Magenta', hex: '923978' },
  { ldraw: 5, name: 'Dark Pink', hex: 'C870A0' },
  { ldraw: 29, name: 'Bright Pink', hex: 'E4ADC8' },
  { ldraw: 13, name: 'Pink', hex: 'FC97AC' },
];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB (0-255) to CIE L*a*b* with a D65 white point. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);

  // sRGB -> XYZ (D65)
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = R * 0.0193339 + G * 0.119192 + B * 0.9503041;

  const Xn = 0.95047;
  const Yn = 1.0;
  const Zn = 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(X / Xn);
  const fy = f(Y / Yn);
  const fz = f(Z / Zn);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIEDE2000 colour difference. Worth the extra maths here: naive RGB distance
 * routinely picks a muddy brown where a human would obviously reach for tan,
 * and colour is half of whether the finished model "looks like" the photo.
 */
export function deltaE2000(lab1: readonly number[], lab2: readonly number[]): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const kL = 1;
  const kC = 1;
  const kH = 1;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const hp = (bb: number, ap: number) => {
    if (bb === 0 && ap === 0) return 0;
    const h = Math.atan2(bb, ap) * deg;
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;

  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
      Math.pow(dCp / (kC * Sc), 2) +
      Math.pow(dHp / (kH * Sh), 2) +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

export const PALETTE: LegoColor[] = RAW.map((c) => {
  const rgb = hexToRgb(c.hex);
  return {
    ldraw: c.ldraw,
    name: c.name,
    hex: `#${c.hex}`,
    rgb,
    lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
  };
});

export const COLOR_BY_LDRAW = new Map<number, LegoColor>(PALETTE.map((c) => [c.ldraw, c]));

/**
 * Index (into `palette`) of the perceptually closest LEGO colour.
 * Returns both the index and the error so callers can report fidelity.
 */
export function nearestColorIndex(
  lab: readonly number[],
  palette: readonly LegoColor[] = PALETTE,
): { index: number; deltaE: number } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = deltaE2000(lab, palette[i].lab);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { index: best, deltaE: bestD };
}
