import type { Stroke } from '../../domain/entities';
import type { RecognitionRegion, RecognitionSnapshot, RegionAssetExporter } from '../../domain/recognition';
import { exportSvg } from '../../application/export-service';

export class SvgRegionExporter implements RegionAssetExporter {
  export(snapshot: RecognitionSnapshot, region: RecognitionRegion): string {
    const ids = new Set(region.strokeIds);
    const strokes: Stroke[] = snapshot.strokes
      .filter((stroke) => ids.has(stroke.id))
      .map((stroke) => ({
        ...stroke,
        points: stroke.points.map((point) => [point[0], point[1], point[2]]),
      }));
    if (strokes.length === 0) throw new Error(`Region ${region.id} has no strokes.`);
    return exportSvg(strokes, { type: 'blank', color: 'transparent', grid: false, gridSize: 20 });
  }
}
