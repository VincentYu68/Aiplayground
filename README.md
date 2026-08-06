# Brickify

Turn a photo of an object into a LEGO model you can actually build, with a 3D
interactive step-by-step manual.

Everything runs in the browser. The photo never leaves the device — there is no
server, no upload, and no API key.

```bash
npm install
npm run dev           # http://localhost:5173
npm test              # 44 tests over the generator
npm run build         # static site in dist/
npm run build:single  # one self-contained page, dist-single/brickify.html
```

`build:single` inlines the CSS and JS into a single HTML file for hosts that
serve one page and block external requests. It sets `VITE_NO_WORKER=1`, which
drops the web worker and runs the generator on the main thread instead — the
page freezes for the fraction of a second the build takes, rather than staying
responsive. Use the normal build anywhere a second file can be served.

## What it does

1. **Cuts the object out of the photo.** A colour-model classifier separates
   foreground from background; a brush and a bounding box are there for the
   photos it gets wrong.
2. **Lifts the silhouette into a solid.** Three modes: a rounded solid that
   bulges front and back, a solid of revolution for anything turned on a lathe,
   and a flat-backed relief. The far side is treated as unknown rather than
   assumed — see below.
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

## Recovering real 3D from several photos

One photograph cannot describe a solid. Extruding its silhouette and rounding
the result reads correctly from the camera's position and falls apart the
moment you orbit it — the shape was never there.

Two or more photographs taken around the object do contain the shape.
Each silhouette back-projects to a generalised cone containing the object, and
the object lies in the intersection of all of them. That intersection — the
visual hull — is genuine recovered geometry, not a guess:

| Object | 1 view | 2 views | 4 views | 8 views |
|---|---|---|---|---|
| Box, truly 2:1 wide vs deep | 0.96:1 | **2.00:1** | 2.00:1 | — |
| Cylinder (a circle fills 79% of its bounding square) | 100% | 100% | 82% | **79%** |

Two perpendicular views pin a box exactly; eight views reproduce a circle to
the decimal. Add angles in the first panel and set each one's direction.

Scale is shared between views by assuming the object is the same height in all
of them — so shoot from roughly the same distance, upright. Angles are taken
relative to the first view, so only the angles *between* photos matter.
Projection is orthographic: recovering perspective would need the camera's
focal length and distance, which a dropped photo does not carry.

**What it cannot recover** is concavity that never breaks the silhouette — the
inside of a bowl seen only from outside. That is a property of shape-from-
silhouette, not of this implementation. With a single photo the app falls back
to silhouette extrusion and says so in the report.

## The side the camera never saw

Half of any solid model is a side the photograph does not show, and the
tempting default — mirroring the front — is the one answer that is reliably
wrong. It puts a second face on the back of a head and a second grille on the
back of a car, and because those features are bright and recognisable, the
error is far more visible than any amount of smoothing would be.

Two things are therefore kept off the back:

- **Shading relief.** Luminance only describes the surface facing the camera,
  so it shapes the front alone. The back gets the bare geometric bulge that the
  silhouette implies.
- **Front colours.** There is one part of the photo that genuinely describes
  the far side: the pixels along the silhouette, which are the surface seen
  edge-on at the point where it turns away and continues round the back.
  Carrying that colour inwards — a nearest-boundary feature transform — gives
  the object's own wrap-around colour: the hair around a face, the paint around
  a grille.

These apply to the single-photo fallback. With several views the far side is
photographed rather than guessed, and each surface voxel takes its colour from
whichever camera faces it most squarely, resolved through a per-view depth
buffer so a voxel never takes colour from a camera that could not see it.

`Back of the model` offers **wrap the edges round** (the default), **plain
back** (one solid colour, cheapest and most honest), and **mirror the front**
for the cases where the object really is symmetric.

On a synthetic head, wrapping removes skin tones from the back entirely
(under 2% of the rear surface, against 33% when mirrored) while leaving the
photographed front pixel-for-pixel identical.

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

**A colour boundary is a structural joint, in every axis.** The front/back
colour change is a plane no part may cross, and pinned at a fixed depth it
becomes a crack running through the whole model — the vertical-band problem
lying on its side. Walking that boundary a stud back and forth between courses
fixed it and then paid for itself: the wrapped back ends up using *fewer* parts
than the old mirrored one (2818 vs 2944 on the test head) and scores higher for
stability (91 vs 90).

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
