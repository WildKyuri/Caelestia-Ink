import { getStroke } from 'perfect-freehand';
import type { RecognitionSnapshot, ReferenceImage, ReferenceRenderer } from '../../domain/recognition';

const PADDING = 20;
const MAX_SIDE = 2048;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Conversion cancelled.', 'AbortError');
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG export returned no data.')), 'image/png');
  });
}

export class CanvasReferenceRenderer implements ReferenceRenderer {
  async render(snapshot: RecognitionSnapshot, signal: AbortSignal): Promise<ReferenceImage> {
    throwIfAborted(signal);
    const bounds = snapshot.contentBounds;
    const logicalWidth = Math.max(1, bounds.width + PADDING * 2);
    const logicalHeight = Math.max(1, bounds.height + PADDING * 2);
    const scale = Math.min(2, MAX_SIDE / logicalWidth, MAX_SIDE / logicalHeight);
    const width = Math.max(1, Math.ceil(logicalWidth * scale));
    const height = Math.max(1, Math.ceil(logicalHeight * scale));
    const canvas = createEl('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable for PNG export.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-bounds.x + PADDING, -bounds.y + PADDING);
    for (const stroke of snapshot.strokes) {
      throwIfAborted(signal);
      const outline = getStroke(stroke.points.map((point) => [point[0], point[1], point[2]]), {
        size: stroke.size,
        thinning: 0.5,
        simulatePressure: !stroke.hasPressure,
      });
      if (outline.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length - 1; i++) {
        const current = outline[i];
        const next = outline[i + 1];
        ctx.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) / 2, (current[1] + next[1]) / 2);
      }
      ctx.closePath();
      // OCR reference: normalize board colours to dark ink on white. The original colour and
      // opacity remain intact in the snapshot and regional SVG assets.
      ctx.globalAlpha = stroke.tool === 'highlighter' ? 0.35 : 1;
      ctx.fillStyle = stroke.tool === 'highlighter' ? '#666666' : '#000000';
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    throwIfAborted(signal);
    const blob = await canvasToBlob(canvas);
    throwIfAborted(signal);
    return { data: await blob.arrayBuffer(), width, height, contentBounds: bounds };
  }
}
