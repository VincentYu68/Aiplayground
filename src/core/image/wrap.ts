/**
 * Guessing what the back of the object looks like.
 *
 * A single photograph contains no information about the far side, and the
 * tempting default — mirroring the front — is the one answer that is reliably
 * wrong. It puts a second face on the back of a head and a second grille on
 * the back of a car, and because those features are bright and recognisable,
 * the error is far more visible than any amount of smoothing would be.
 *
 * There is one part of the photo that genuinely does describe the far side:
 * the pixels along the silhouette. Those are the surface seen edge-on, at the
 * exact point where it turns away from the camera and continues round the
 * back. Carrying that colour inwards gives the back the object's own wrap-around
 * colour — the hair around a face, the paint around a grille — which is a
 * defensible guess rather than a confident fabrication.
 *
 * Implemented as a nearest-boundary feature transform: a multi-source BFS from
 * the silhouette pixels, recording which boundary pixel each interior pixel
 * reached first.
 */

import type { Mask } from './raster';

/**
 * For every foreground pixel, the index of the nearest silhouette pixel.
 * Background pixels are -1.
 */
export function nearestEdgePixel(mask: Mask, width: number, height: number): Int32Array {
  const n = width * height;
  const source = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  // Seed with the silhouette: foreground pixels touching background or the
  // frame edge.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const boundary =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !mask[i - 1] ||
        !mask[i + 1] ||
        !mask[i - width] ||
        !mask[i + width];
      if (boundary) {
        source[i] = i;
        queue[tail++] = i;
      }
    }
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p / width) | 0;
    const src = source[p];

    if (x > 0 && mask[p - 1] && source[p - 1] < 0) {
      source[p - 1] = src;
      queue[tail++] = p - 1;
    }
    if (x < width - 1 && mask[p + 1] && source[p + 1] < 0) {
      source[p + 1] = src;
      queue[tail++] = p + 1;
    }
    if (y > 0 && mask[p - width] && source[p - width] < 0) {
      source[p - width] = src;
      queue[tail++] = p - width;
    }
    if (y < height - 1 && mask[p + width] && source[p + width] < 0) {
      source[p + width] = src;
      queue[tail++] = p + width;
    }
  }

  return source;
}
