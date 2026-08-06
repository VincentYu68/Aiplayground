/**
 * Max-flow / min-cut on a grid graph, by Dinic's algorithm.
 *
 * This is what makes the segmentation *global* rather than per-pixel. Deciding
 * each pixel on its own colour can only ever produce speckle and ragged edges;
 * a min-cut picks the labelling that jointly minimises colour mismatch and
 * boundary length over the whole image at once, so the boundary lands on real
 * image edges and isolated wrong pixels cost more than they save.
 *
 * Capacities are integers on purpose. With floating-point capacities an
 * augmenting-path method can take arbitrarily many vanishing augmentations to
 * terminate; on integers every augmentation moves at least one unit, so it
 * always finishes.
 */

const SOURCE_OFFSET = 0;

export class MaxFlow {
  readonly nodeCount: number;
  private readonly source: number;
  private readonly sink: number;

  private head: Int32Array;
  private nextEdge: Int32Array;
  private to: Int32Array;
  private cap: Int32Array;
  private edgeCount = 0;

  private level: Int32Array;
  private iter: Int32Array;
  private queue: Int32Array;

  /**
   * @param nodeCount pixels; the source and sink are added on top
   * @param edgeHint expected number of undirected edges, for preallocation
   */
  constructor(nodeCount: number, edgeHint: number) {
    this.nodeCount = nodeCount;
    this.source = nodeCount + SOURCE_OFFSET;
    this.sink = nodeCount + 1;
    const total = nodeCount + 2;

    this.head = new Int32Array(total).fill(-1);
    const slots = (edgeHint + nodeCount * 2 + 8) * 2;
    this.nextEdge = new Int32Array(slots);
    this.to = new Int32Array(slots);
    this.cap = new Int32Array(slots);
    this.level = new Int32Array(total);
    this.iter = new Int32Array(total);
    this.queue = new Int32Array(total);
  }

  private link(u: number, v: number, capacity: number): void {
    const e = this.edgeCount++;
    this.to[e] = v;
    this.cap[e] = capacity;
    this.nextEdge[e] = this.head[u];
    this.head[u] = e;
  }

  /** An undirected pair of residual arcs between two pixels. */
  addEdge(u: number, v: number, capacity: number, reverse: number): void {
    this.link(u, v, capacity);
    this.link(v, u, reverse);
  }

  /** Cost of separating this pixel from the source, and from the sink. */
  addTerminals(node: number, fromSource: number, toSink: number): void {
    if (fromSource > 0) {
      this.link(this.source, node, fromSource);
      this.link(node, this.source, 0);
    }
    if (toSink > 0) {
      this.link(node, this.sink, toSink);
      this.link(this.sink, node, 0);
    }
  }

  private buildLevels(): boolean {
    this.level.fill(-1);
    let head = 0;
    let tail = 0;
    this.level[this.source] = 0;
    this.queue[tail++] = this.source;
    while (head < tail) {
      const u = this.queue[head++];
      for (let e = this.head[u]; e !== -1; e = this.nextEdge[e]) {
        if (this.cap[e] <= 0) continue;
        const v = this.to[e];
        if (this.level[v] !== -1) continue;
        this.level[v] = this.level[u] + 1;
        this.queue[tail++] = v;
      }
    }
    return this.level[this.sink] !== -1;
  }

  /** Iterative DFS: the recursive form blows the stack on a big grid. */
  private blockingFlow(): number {
    let total = 0;
    const path = new Int32Array(this.nodeCount + 2);
    const pathEdge = new Int32Array(this.nodeCount + 2);

    for (;;) {
      let u = this.source;
      let depth = 0;

      for (;;) {
        if (u === this.sink) {
          // Push the bottleneck back along the path.
          let bottleneck = Infinity;
          for (let i = 0; i < depth; i++) {
            bottleneck = Math.min(bottleneck, this.cap[pathEdge[i]]);
          }
          for (let i = 0; i < depth; i++) {
            this.cap[pathEdge[i]] -= bottleneck;
            this.cap[pathEdge[i] ^ 1] += bottleneck;
          }
          total += bottleneck;
          // Restart from the first edge that saturated.
          let cut = 0;
          while (cut < depth && this.cap[pathEdge[cut]] > 0) cut++;
          depth = cut;
          u = depth === 0 ? this.source : path[depth];
          continue;
        }

        let advanced = false;
        for (let e = this.iter[u]; e !== -1; e = this.nextEdge[e]) {
          this.iter[u] = e;
          const v = this.to[e];
          if (this.cap[e] > 0 && this.level[v] === this.level[u] + 1) {
            path[depth] = u;
            pathEdge[depth] = e;
            depth++;
            u = v;
            advanced = true;
            break;
          }
        }
        if (advanced) continue;

        // Dead end: retire this node and back up.
        this.iter[u] = -1;
        this.level[u] = -1;
        if (depth === 0) return total;
        depth--;
        u = path[depth];
        this.iter[u] = this.nextEdge[this.iter[u]];
      }
    }
  }

  compute(): number {
    let flow = 0;
    while (this.buildLevels()) {
      for (let i = 0; i < this.nodeCount + 2; i++) this.iter[i] = this.head[i];
      flow += this.blockingFlow();
    }
    return flow;
  }

  /**
   * Which side of the cut each pixel landed on. Nodes still reachable from the
   * source through residual capacity are the source side.
   */
  sourceSide(): Uint8Array {
    const seen = new Uint8Array(this.nodeCount + 2);
    let head = 0;
    let tail = 0;
    seen[this.source] = 1;
    this.queue[tail++] = this.source;
    while (head < tail) {
      const u = this.queue[head++];
      for (let e = this.head[u]; e !== -1; e = this.nextEdge[e]) {
        if (this.cap[e] <= 0) continue;
        const v = this.to[e];
        if (seen[v]) continue;
        seen[v] = 1;
        this.queue[tail++] = v;
      }
    }
    return seen;
  }
}
