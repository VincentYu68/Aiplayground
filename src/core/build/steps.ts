/**
 * Turning a pile of placements into a manual a human can follow.
 *
 * Rules that make instructions readable, in priority order:
 *   1. never ask for a part before the thing it rests on exists — so steps go
 *      strictly bottom-up
 *   2. keep each step small enough to take in at a glance
 *   3. within a step, keep the parts near each other, and work back-to-front
 *      and left-to-right so the builder's hand never covers the next piece
 */

import type { BuildStep, Placement } from '../../types';

export function orderPlacements(placements: Placement[]): Placement[] {
  return [...placements].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    // Bricks before plates on the same level: they carry the course.
    if (a.height !== b.height) return b.height - a.height;
    if (a.z !== b.z) return a.z - b.z;
    return a.x - b.x;
  });
}

/**
 * Split one layer's worth of parts into steps, keeping each step's parts
 * spatially clustered rather than just slicing the sorted list.
 */
function chunkLayer(layer: Placement[], partsPerStep: number): Placement[][] {
  if (layer.length <= partsPerStep) return [layer];

  const remaining = [...layer];
  const chunks: Placement[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const chunk = [seed];
    // Grow the chunk by repeatedly taking the part closest to its centroid.
    while (chunk.length < partsPerStep && remaining.length > 0) {
      let cx = 0;
      let cz = 0;
      for (const p of chunk) {
        cx += p.x + p.w / 2;
        cz += p.z + p.d / 2;
      }
      cx /= chunk.length;
      cz /= chunk.length;

      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i];
        const d = (p.x + p.w / 2 - cx) ** 2 + (p.z + p.d / 2 - cz) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      chunk.push(remaining.splice(bestIdx, 1)[0]);
    }
    chunk.sort((a, b) => a.z - b.z || a.x - b.x);
    chunks.push(chunk);
  }
  return chunks;
}

export function buildSteps(placements: Placement[], partsPerStep: number): BuildStep[] {
  const ordered = orderPlacements(placements);
  const steps: BuildStep[] = [];
  const perStep = Math.max(1, Math.round(partsPerStep));

  let i = 0;
  let cumulative = 0;
  while (i < ordered.length) {
    const y = ordered[i].y;
    const layer: Placement[] = [];
    while (i < ordered.length && ordered[i].y === y) {
      layer.push(ordered[i]);
      i++;
    }
    for (const chunk of chunkLayer(layer, perStep)) {
      cumulative += chunk.length;
      steps.push({
        index: steps.length,
        course: Math.floor(y / 3),
        placements: chunk,
        cumulativeParts: cumulative,
      });
    }
  }
  return steps;
}
