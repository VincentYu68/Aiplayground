# Segmentation model

These files are ONNX exports of **MobileSAM**'s published `vit_t` checkpoint:

- `mobilesam-encoder.onnx` — TinyViT image encoder, dynamically quantised to
  int8 on `MatMul` nodes only. Quantising the `Conv` nodes as well costs about
  27 points of mean IoU on `bench/`; see the README.
- `mobilesam-decoder.onnx` — prompt encoder and mask decoder, int8.

MobileSAM (<https://github.com/ChaoningZhang/MobileSAM>) is a distillation of
Meta AI's Segment Anything (<https://github.com/facebookresearch/segment-anything>).

Both are licensed Apache-2.0. These exports are redistributions of that work;
no model was trained in this project.

## Monocular depth

`depth-anything-v2-small-int8.onnx` is **Depth Anything V2 Small** (24.7M
parameters), the ViT-S variant.

- Upstream weights and code: <https://github.com/DepthAnything/Depth-Anything-V2>,
  licensed **Apache-2.0**.
- The fp32 ONNX export it was quantised from came from the releases of
  <https://github.com/fabio-sim/Depth-Anything-ONNX>, also Apache-2.0.
- Input `l_x_`, `[1,3,518,518]`, RGB, NCHW, normalised with the ImageNet mean
  and standard deviation over 0..1. The 518 is baked into the export — the
  position embeddings were interpolated for that patch grid — so it cannot be
  changed without re-exporting from the PyTorch checkpoint.
- Output `select_36`, `[1,518,518]`, **inverse relative depth**: larger is
  nearer, and the scale and shift are arbitrary and differ per image. It is not
  metric and nothing downstream treats it as though it were.

### What the quantisation did

The published export wraps every transformer block in an ONNX *local function*,
so `quantize_dynamic` saw no `MatMul` nodes at all and returned the model
unchanged at 99MB. Inlining with `onnx.inliner.inline_local_functions` exposes
the operators but leaves the weights behind `Cast` nodes, where
`MatMulConstBOnly` still cannot find them. Running the inlined graph through
onnxruntime's `ORT_ENABLE_ALL` graph optimisation folds those casts away; a
dynamic int8 quantisation of the resulting `MatMul` nodes then takes it to
**35MB**, with all 48 matrix multiplies replaced by `MatMulInteger`.

`Conv` and `Gemm` are deliberately left in float, matching the recipe used for
the segmentation encoder above.

No model was trained or fine-tuned in this project; these are redistributions.

## Object recognition

`mobilenet-classifier.onnx` is MobileNetV2 (int8) from the ONNX Model Zoo,
<https://github.com/onnx/models>, Apache-2.0, redistributed unmodified.

It chooses among a few shape archetypes for the single-photograph depth prior.
Its record on real photographs is mixed and worth knowing before relying on it:
on the benchmark corpus it correctly calls a mug a body of revolution, and
correctly calls a teddy bear rounded, but it calls a photographed car a "jigsaw
puzzle" — archetype *flat* — confidently enough to clear its threshold. Left
unchecked that turned a 32x16-stud car into a 32x3-stud sheet. The depth map now
brackets how far this prior may move the depth extent; see `bracketByRelief` in
`src/core/voxel/voxelize.ts`.
