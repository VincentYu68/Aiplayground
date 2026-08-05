# Brickify

Turn a photo of an object into a LEGO model you can actually build, with a 3D
interactive step-by-step manual.

Everything runs in the browser. The photo never leaves the device — there is no
server, no upload, and no API key.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 44 tests over the generator
npm run build    # static site in dist/
```

## What it does

1. **Cuts the object out of the photo.** A colour-model classifier separates
   foreground from background; a brush and a bounding box are there for the
   photos it gets wrong.
2. **Lifts the silhouette into a solid.** Three modes: a rounded solid that
   bulges front and back, a solid of revolution for anything turned on a lathe,
   and a flat-backed relief.
3. **Samples it onto the LEGO lattice** — 8mm across, 3.2mm per plate — and
   reduces the colours to a chosen number of real LEGO colours using CIEDE2000.
4. **Chooses the bricks**, scoring every candidate placement for size, stud
   overlap and — most importantly — whether it reproduces a joint in the course
   below.
5. **Checks that it holds together**, repairs what it can, and reports what it
   could not.
6. **Writes the manual**: a 3D viewer you can step through, plus LDraw, a
   printable booklet, a CSV parts list and a Bricklink wanted list.

## Constraints it respects

**Only standard parts.** Bricks and plates from 1x1 up to 8x16, every one of
them an ordinary System element that has been in production for decades. No
slopes, tiles, brackets or SNOT parts. Exported LDraw files reference real
element numbers, and the Bricklink export is a wanted list you can buy from.

**It has to stand up.** Three separate properties are checked, and they are not
the same thing:

- *Connectivity.* Two parts side by side in the same layer are **not** joined —
  only a part above or below that spans them joins anything. The generator
  builds the part graph on vertical overlap alone and repairs anything that
  falls out of it.
- *Buildability.* Every part must have something under it when its turn comes,
  or be clamped by the course above. The second case is legitimate LEGO and the
  manual flags those parts as "hold this until the next course".
- *Bond.* Joints are staggered against the course below, the way a bricklayer
  lays a running bond. A model whose joints stack up is a set of loose columns.

**It has to look like the photo.** Reported, not asserted: silhouette overlap
as intersection-over-union against the cut-out, and mean CIEDE2000 colour error
against the source pixels. The front-on model preview is drawn at the real
8 : 3.2 stud-to-plate ratio so the side-by-side comparison is honest.

## Two findings worth knowing about

**Colour boundaries are structural.** A part can only be one colour, so a colour
boundary is a line no part can cross. A photo with broad vertical shading — a
vase, a bottle, a face lit from one side — puts that boundary at the same stud
on every course, and the result is a crack running the full height that splits
the model into slabs leaning on each other. The generator nudges the colour
decision by a fraction of a percent per course, which moves the boundary a stud
either way between courses without any visible change, and lets the next course
reach across. On the test vase this took the model from 8 loose sections to one
piece.

**Hollowing has to be measured in millimetres.** A voxel step is 8mm sideways
and 3.2mm vertically. Carving out "two voxels" of shell leaves 16mm through a
wall but 6.4mm through a floor — thinner than a single brick — and the model
quietly separates into unconnected shells. Shell thickness is a real distance,
found with a bucket-queue Dijkstra over the true step costs.

## Choosing settings

The defaults are chosen to produce something buildable; the two that change the
result most:

- **Bricks only** (on by default) builds in whole 3-plate courses. Turning it
  off doubles vertical resolution, but on a curved object each extra plate layer
  is a one-plate ring overhanging the layer beneath, which roughly doubles the
  part count and tends to leave the model in sections. The stability score says
  so when it happens.
- **Colours** trades fidelity against cost and strength. More colours track the
  photo more closely but make narrower bands, which forces smaller parts.

## Layout

```
src/core/lego/       units, colour palette with LDraw codes, part catalogue
src/core/image/      segmentation, depth estimation, raster helpers
src/core/voxel/      the grid, sampling, colour reduction, hollowing
src/core/build/      tiling, stability analysis and repair, steps, pipeline
src/core/export/     LDraw, printable manual, parts list, Bricklink
src/render/          three.js brick geometry and the manual viewer
src/ui/              React components
src/worker/          runs the generator off the main thread
tests/               unit and end-to-end tests of the generator
```

`src/core` is pure and synchronous — no DOM, no canvas, no network — so it runs
in a worker, is testable in node, and is reproducible for a given seed.
