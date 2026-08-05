/**
 * Getting a photo into a plain pixel buffer.
 *
 * Working resolution is capped deliberately. A 12-megapixel phone photo carries
 * no more usable information for a 32-stud model than a 512px one does, and the
 * segmentation is O(pixels) with a large constant.
 */

export interface SourceImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Downscaled copy for display in the editor. */
  dataUrl: string;
}

export const WORKING_MAX_DIM = 512;

export async function loadImageFile(file: File, maxDim = WORKING_MAX_DIM): Promise<SourceImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return drawToBuffer(bitmap, maxDim);
  } finally {
    bitmap.close();
  }
}

function drawToBuffer(bitmap: ImageBitmap, maxDim: number): SourceImage {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D drawing context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);

  return {
    rgba: imageData.data,
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

/**
 * Render an RGBA buffer to a data URL, for previews.
 *
 * `scaleX` and `scaleY` are separate on purpose. A model preview has one pixel
 * per stud across and one per plate up, and those are 8mm and 3.2mm — drawing
 * it with square pixels stretches the model to two and a half times its real
 * height and makes the side-by-side comparison with the photo meaningless.
 */
export function bufferToDataUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  scaleX = 1,
  scaleY = scaleX,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  if (scaleX === 1 && scaleY === 1) return canvas.toDataURL('image/png');

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(width * scaleX));
  out.height = Math.max(1, Math.round(height * scaleY));
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
