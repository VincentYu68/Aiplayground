/**
 * Where the user tells the app what the object actually is.
 *
 * Automatic segmentation gets most photos right and some photos wrong, and
 * there is no amount of cleverness downstream that recovers from a mask which
 * ate half the object. Two brush strokes fix it in a second, so the brush is
 * front and centre rather than hidden behind an "advanced" disclosure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceImage } from '../lib/loadImage';

export type Tool = 'keep' | 'remove' | 'box';

interface Props {
  source: SourceImage;
  mask: Uint8Array | null;
  hints: Uint8Array;
  rect: { x0: number; y0: number; x1: number; y1: number } | null;
  onPaint: (hints: Uint8Array, localMask: Uint8Array | null) => void;
  onRect: (rect: { x0: number; y0: number; x1: number; y1: number } | null) => void;
  onCommit: () => void;
}

export function MaskEditor({ source, mask, hints, rect, onPaint, onRect, onCommit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('keep');
  const [brushSize, setBrushSize] = useState(18);
  const painting = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<typeof rect>(null);

  const { width, height } = source;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const image = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const inside = mask ? mask[i] === 1 : true;
      if (inside) {
        image.data[p] = source.rgba[p];
        image.data[p + 1] = source.rgba[p + 1];
        image.data[p + 2] = source.rgba[p + 2];
        image.data[p + 3] = 255;
      } else {
        // Background: desaturated and darkened so the silhouette reads instantly.
        const l = 0.2126 * source.rgba[p] + 0.7152 * source.rgba[p + 1] + 0.0722 * source.rgba[p + 2];
        const v = 18 + l * 0.22;
        image.data[p] = v;
        image.data[p + 1] = v + 2;
        image.data[p + 2] = v + 6;
        image.data[p + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);

    if (mask) {
      // Outline the silhouette.
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (!mask[i]) continue;
          const edge =
            x === 0 ||
            y === 0 ||
            x === width - 1 ||
            y === height - 1 ||
            !mask[i - 1] ||
            !mask[i + 1] ||
            !mask[i - width] ||
            !mask[i + width];
          if (edge) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + 1, y);
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    const box = dragRect ?? rect;
    if (box) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 214, 102, 0.95)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        Math.min(box.x0, box.x1),
        Math.min(box.y0, box.y1),
        Math.abs(box.x1 - box.x0),
        Math.abs(box.y1 - box.y0),
      );
      ctx.restore();
    }
  }, [mask, rect, dragRect, source, width, height]);

  useEffect(() => {
    draw();
  }, [draw]);

  const toImageCoords = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - bounds.left) / bounds.width) * width),
      y: Math.round(((event.clientY - bounds.top) / bounds.height) * height),
    };
  };

  const paintAt = (cx: number, cy: number) => {
    const value = tool === 'keep' ? 1 : 2;
    const r = Math.max(1, Math.round((brushSize / 2) * (width / 512)));
    const nextHints = hints;
    const localMask = mask ? Uint8Array.from(mask) : null;
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= width) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = y * width + x;
        nextHints[i] = value;
        if (localMask) localMask[i] = value === 1 ? 1 : 0;
      }
    }
    onPaint(nextHints, localMask);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = toImageCoords(event);
    if (tool === 'box') {
      dragStart.current = { x, y };
      setDragRect({ x0: x, y0: y, x1: x, y1: y });
      return;
    }
    painting.current = true;
    paintAt(x, y);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toImageCoords(event);
    if (tool === 'box') {
      if (!dragStart.current) return;
      setDragRect({ x0: dragStart.current.x, y0: dragStart.current.y, x1: x, y1: y });
      return;
    }
    if (!painting.current) return;
    paintAt(x, y);
  };

  const onPointerUp = () => {
    if (tool === 'box') {
      if (dragRect && Math.abs(dragRect.x1 - dragRect.x0) > 8 && Math.abs(dragRect.y1 - dragRect.y0) > 8) {
        onRect({
          x0: Math.min(dragRect.x0, dragRect.x1),
          y0: Math.min(dragRect.y0, dragRect.y1),
          x1: Math.max(dragRect.x0, dragRect.x1),
          y1: Math.max(dragRect.y0, dragRect.y1),
        });
      }
      dragStart.current = null;
      setDragRect(null);
      onCommit();
      return;
    }
    if (!painting.current) return;
    painting.current = false;
    onCommit();
  };

  return (
    <div className="mask-editor">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className={`mask-canvas tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="mask-tools">
        <div className="segmented" role="group" aria-label="Mask tool">
          <button
            type="button"
            className={tool === 'keep' ? 'active' : ''}
            onClick={() => setTool('keep')}
            title="Paint over parts of the object the app missed"
          >
            Keep
          </button>
          <button
            type="button"
            className={tool === 'remove' ? 'active' : ''}
            onClick={() => setTool('remove')}
            title="Paint over background the app kept by mistake"
          >
            Remove
          </button>
          <button
            type="button"
            className={tool === 'box' ? 'active' : ''}
            onClick={() => setTool('box')}
            title="Drag a box around the object"
          >
            Box
          </button>
        </div>
        {tool !== 'box' && (
          <label className="inline-field">
            <span>Brush</span>
            <input
              type="range"
              min={4}
              max={64}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
          </label>
        )}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            hints.fill(0);
            onRect(null);
            onPaint(hints, null);
            onCommit();
          }}
        >
          Reset mask
        </button>
      </div>
    </div>
  );
}
