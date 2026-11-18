import type { RecognitionRegion, RecognitionSnapshot, Rect, SnapshotStroke } from '../../domain/recognition';

function strokeBounds(stroke: SnapshotStroke): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  const pad = stroke.size / 2;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + stroke.size, height: maxY - minY + stroke.size };
}

function near(a: Rect, b: Rect, gap: number): boolean {
  return a.x <= b.x + b.width + gap && b.x <= a.x + a.width + gap &&
    a.y <= b.y + b.height + gap && b.y <= a.y + a.height + gap;
}

function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Deterministic connected-component segmenter. It is scaffolding, not handwriting analysis. */
export function segmentSnapshot(snapshot: RecognitionSnapshot, gap = 40): RecognitionRegion[] {
  const boxes = snapshot.strokes.map(strokeBounds);
  const visited = new Set<number>();
  const components: number[][] = [];
  for (let start = 0; start < snapshot.strokes.length; start++) {
    if (visited.has(start)) continue;
    const queue = [start];
    const component: number[] = [];
    visited.add(start);
    while (queue.length) {
      const current = queue.shift()!;
      component.push(current);
      for (let candidate = 0; candidate < boxes.length; candidate++) {
        if (visited.has(candidate) || !near(boxes[current], boxes[candidate], gap)) continue;
        visited.add(candidate);
        queue.push(candidate);
      }
    }
    components.push(component);
  }
  components.sort((a, b) => {
    const aa = union(a.map((index) => boxes[index]));
    const bb = union(b.map((index) => boxes[index]));
    return aa.y - bb.y || aa.x - bb.x;
  });
  return components.map((indices, index) => ({
    id: `region-${String(index + 1).padStart(3, '0')}`,
    bounds: union(indices.map((i) => boxes[i])),
    strokeIds: indices.map((i) => snapshot.strokes[i].id),
    kind: 'unknown',
    readingOrder: index,
  }));
}

/** One lossless page region for multimodal OCR models that understand layout themselves. */
export function wholePageRegion(snapshot: RecognitionSnapshot): RecognitionRegion[] {
  if (snapshot.strokes.length === 0) return [];
  return [{
    id: 'page-001',
    bounds: snapshot.contentBounds,
    strokeIds: snapshot.strokes.map((stroke) => stroke.id),
    kind: 'unknown',
    readingOrder: 0,
  }];
}
