import type {
  ConversionClassification,
  ConversionDraft,
  IntermediateDocument,
  RenderedConversion,
  RegionAssetExporter,
  RegionKind,
} from '../../domain/recognition';
import { assembleMarkdown } from './markdown-assembler';
import { buildRegionAssets } from './assets';

/** The engine's reading is the starting point; the user can correct it before saving. */
export function initialClassification(document: IntermediateDocument): Map<string, RegionKind> {
  return new Map(document.regions.map((entry) => [entry.regionId, entry.content.kind]));
}

export function renderConversion(
  draft: ConversionDraft,
  classification: ConversionClassification,
  exporter: RegionAssetExporter,
  latexOverrides?: ReadonlyMap<string, string>,
): RenderedConversion {
  return {
    markdown: assembleMarkdown(
      draft.document,
      draft.regions,
      classification,
      draft.destination,
      latexOverrides,
    ),
    assets: buildRegionAssets(draft.snapshot, draft.regions, classification, exporter),
  };
}
