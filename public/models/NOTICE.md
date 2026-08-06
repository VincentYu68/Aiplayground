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
