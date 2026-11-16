import type { Point, Stroke } from '../domain/entities';
import { distToSegment, segmentDistance } from '../domain/geometry';
import { StrokeManager } from '../domain/stroke-manager';

export function findStrokesAtPoint(
  strokes: Stroke[],
  worldX: number,
  worldY: number,
  eraserSize: number,
): string[] {
  const toDelete: string[] = [];
  for (const stroke of strokes) {
    let hit = false;
    for (let pi = 0; pi < stroke.points.length; pi++) {
      const sp = stroke.points[pi];
      const dx = sp[0] - worldX;
      const dy = sp[1] - worldY;
      if (dx * dx + dy * dy < eraserSize * eraserSize) { hit = true; break; }
      if (pi > 0) {
        const prev = stroke.points[pi - 1];
        if (distToSegment(worldX, worldY, prev[0], prev[1], sp[0], sp[1]) < eraserSize) { hit = true; break; }
      }
    }
    if (hit) toDelete.push(stroke.id);
  }
  return toDelete;
}

export function eraseAtPoint(
  strokeManager: StrokeManager,
  worldX: number,
  worldY: number,
  eraserSize: number,
): boolean {
  const effectiveSize = Math.max(eraserSize, 15);
  const toDelete = findStrokesAtPoint(strokeManager.strokes, worldX, worldY, effectiveSize);
  for (const id of toDelete) strokeManager.deleteStroke(id);
  return toDelete.length > 0;
}

export interface EraseResult {
  /** The new stroke list; the same objects are reused for untouched strokes. */
  strokes: Stroke[];
  /** True when at least one stroke lost points (the caller must persist). */
  changed: boolean;
}

/**
 * Rubber-eraser pass along the segment the pointer travelled since the previous move.
 * Unlike `eraseAtPoint`, which deletes whole strokes, this removes only the part of each
 * stroke under the eraser and keeps the rest, splitting a stroke into fragments when the
 * rubber cuts through its middle. Untouched strokes are returned by reference, so a drag
 * that hits nothing costs one distance test per stroke and no allocation.
 */
export function eraseStrokesAlongSegment(
  strokes: Stroke[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  eraserSize: number,
): EraseResult {
  const r = Math.max(eraserSize, 1);
  const out: Stroke[] = [];
  let changed = false;

  for (const stroke of strokes) {
    const pts = stroke.points;
    const n = pts.length;
    if (n === 0) { out.push(stroke); continue; }

    const pointHit: boolean[] = [];
    let anyHit = false;
    for (let i = 0; i < n; i++) {
      const hit = distToSegment(pts[i][0], pts[i][1], x0, y0, x1, y1) < r;
      pointHit.push(hit);
      if (hit) anyHit = true;
    }
    const edgeHit: boolean[] = [];
    for (let i = 0; i < n - 1; i++) {
      const hit = segmentDistance(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], x0, y0, x1, y1) < r;
      edgeHit.push(hit);
      if (hit) anyHit = true;
    }

    if (!anyHit) { out.push(stroke); continue; }
    changed = true;

    // Keep every run of consecutive points the rubber did not touch. An edge that crosses
    // the eraser ends the current run even when both of its endpoints are outside.
    const runs: Point[][] = [];
    let run: Point[] = [];
    for (let i = 0; i < n; i++) {
      if (pointHit[i]) {
        // The rubber covers this point: whatever run was open stops here.
        if (run.length >= 2) runs.push(run);
        run = [];
        continue;
      }
      run.push(pts[i]);
      if (i < n - 1 && edgeHit[i]) {
        if (run.length >= 2) runs.push(run);
        run = [];
      }
    }
    if (run.length >= 2) runs.push(run);

    for (let k = 0; k < runs.length; k++) {
      out.push({
        ...stroke,
        id: `${stroke.id}~${k}`,
        points: runs[k].map((p) => [p[0], p[1], p[2]] as Point),
      });
    }
  }

  return { strokes: out, changed };
}
