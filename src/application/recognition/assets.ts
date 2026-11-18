import type {
  ConversionClassification,
  OutputAsset,
  RecognitionRegion,
  RecognitionSnapshot,
  RegionAssetExporter,
  RegionKind,
} from '../../domain/recognition';

/** One SVG per exported region. Text, equations and tables never reach this path. */
export function regionAssetFileName(regionId: string): string {
  return `${regionId}.svg`;
}

export function effectiveKind(
  region: RecognitionRegion,
  classification: ConversionClassification,
): RegionKind {
  return classification.get(region.id) ?? region.kind;
}

export function isGraphicKind(kind: RegionKind): boolean {
  return kind === 'graphic' || kind === 'unknown';
}

export function sortedRegions(regions: readonly RecognitionRegion[]): RecognitionRegion[] {
  return [...regions].sort((a, b) => a.readingOrder - b.readingOrder);
}

/**
 * Only graphic and pending regions keep a visual asset. Everything that became Markdown
 * (text, LaTeX, tables) is exported as text and must not duplicate the strokes as an image.
 */
export function buildRegionAssets(
  snapshot: RecognitionSnapshot,
  regions: readonly RecognitionRegion[],
  classification: ConversionClassification,
  exporter: RegionAssetExporter,
): OutputAsset[] {
  return sortedRegions(regions)
    .filter((region) => isGraphicKind(effectiveKind(region, classification)))
    .map((region) => ({
      key: region.id,
      fileName: regionAssetFileName(region.id),
      mimeType: 'image/svg+xml' as const,
      data: exporter.export(snapshot, region),
    }));
}
