import type { BlackboardFile } from '../../domain/entities';
import type { RecognitionSnapshot, Rect, SnapshotStroke } from '../../domain/recognition';

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function calculateBounds(strokes: readonly SnapshotStroke[], file: BlackboardFile): Rect {
  if (strokes.length === 0) {
    return { x: 0, y: 0, width: Math.max(1, finite(file.width, 800)), height: Math.max(1, finite(file.height, 600)) };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxSize = 0;
  for (const stroke of strokes) {
    maxSize = Math.max(maxSize, stroke.size);
    for (const point of stroke.points) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
  const padding = maxSize / 2;
  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(1, maxX - minX + maxSize),
    height: Math.max(1, maxY - minY + maxSize),
  };
}

function canonicalPayload(file: BlackboardFile, strokes: readonly SnapshotStroke[]): string {
  return JSON.stringify({
    version: file.version,
    width: file.width,
    height: file.height,
    strokes: strokes.map((stroke) => ({
      id: stroke.id,
      tool: stroke.tool,
      color: stroke.color,
      size: stroke.size,
      opacity: stroke.opacity,
      points: stroke.points,
      hasPressure: stroke.hasPressure,
      timestamp: stroke.timestamp,
    })),
  });
}

async function sha256(text: string): Promise<string> {
  const subtle = activeWindow.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is not available in this runtime.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function freezeSnapshot(snapshot: RecognitionSnapshot): RecognitionSnapshot {
  for (const stroke of snapshot.strokes) {
    for (const point of stroke.points) Object.freeze(point);
    Object.freeze(stroke.points);
    Object.freeze(stroke);
  }
  Object.freeze(snapshot.strokes);
  Object.freeze(snapshot.contentBounds);
  return Object.freeze(snapshot);
}

export async function createRecognitionSnapshot(
  sourcePath: string,
  file: BlackboardFile,
): Promise<RecognitionSnapshot> {
  const strokes: SnapshotStroke[] = file.strokes.map((stroke) => ({
    id: stroke.id,
    tool: stroke.tool,
    color: stroke.color,
    size: finite(stroke.size),
    opacity: finite(stroke.opacity, 1),
    points: stroke.points.map((point) => [finite(point[0]), finite(point[1]), finite(point[2], 0.5)] as const),
    hasPressure: stroke.hasPressure,
    timestamp: finite(stroke.timestamp),
  }));
  const fingerprint = await sha256(canonicalPayload(file, strokes));
  return freezeSnapshot({
    sourcePath,
    sourceVersion: file.version,
    fingerprint,
    width: Math.max(1, finite(file.width, 800)),
    height: Math.max(1, finite(file.height, 600)),
    contentBounds: calculateBounds(strokes, file),
    strokes,
  });
}
