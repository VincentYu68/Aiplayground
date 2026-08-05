/**
 * A dense voxel grid on the LEGO lattice.
 *
 * X and Z are studs, Y counts plate layers upward from the build surface.
 * The grid is deliberately anisotropic — one cell is 8 x 3.2 x 8 mm — because
 * that is what the real system is, and pretending otherwise is how photo-to-
 * LEGO tools end up producing models that are 2.5x too tall.
 */

export const EMPTY = -1;

export class VoxelGrid {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** Palette index per cell, or EMPTY. */
  readonly cells: Int16Array;

  constructor(sx: number, sy: number, sz: number) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.cells = new Int16Array(sx * sy * sz).fill(EMPTY);
  }

  index(x: number, y: number, z: number): number {
    return (y * this.sz + z) * this.sx + x;
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return EMPTY;
    return this.cells[this.index(x, y, z)];
  }

  set(x: number, y: number, z: number, value: number): void {
    if (!this.inside(x, y, z)) return;
    this.cells[this.index(x, y, z)] = value;
  }

  filled(x: number, y: number, z: number): boolean {
    return this.get(x, y, z) !== EMPTY;
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== EMPTY) n++;
    return n;
  }

  /** A copy of one horizontal layer, row-major over (z, x). */
  layer(y: number): Int16Array {
    const out = new Int16Array(this.sx * this.sz);
    const base = y * this.sz * this.sx;
    out.set(this.cells.subarray(base, base + this.sx * this.sz));
    return out;
  }

  clone(): VoxelGrid {
    const g = new VoxelGrid(this.sx, this.sy, this.sz);
    g.cells.set(this.cells);
    return g;
  }

  /** True when the cell has at least one empty face neighbour. */
  isSurface(x: number, y: number, z: number): boolean {
    if (!this.filled(x, y, z)) return false;
    return (
      !this.filled(x - 1, y, z) ||
      !this.filled(x + 1, y, z) ||
      !this.filled(x, y - 1, z) ||
      !this.filled(x, y + 1, z) ||
      !this.filled(x, y, z - 1) ||
      !this.filled(x, y, z + 1)
    );
  }
}
