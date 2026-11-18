import type {
  ConversionClassification,
  ConversionDestination,
  IntermediateDocument,
  RecognitionRegion,
  RegionContent,
  RegionKind,
} from '../../domain/recognition';
import { effectiveKind, regionAssetFileName, sortedRegions } from './assets';

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function frontmatter(document: IntermediateDocument): string[] {
  const lines = [
    '---',
    `caelestia_source: ${quote(document.sourcePath)}`,
    `caelestia_fingerprint: ${quote(document.sourceFingerprint)}`,
    `caelestia_engine: ${quote(document.engineId)}`,
  ];
  if (document.simulated) lines.push('caelestia_simulated: true');
  lines.push('---');
  return lines;
}

function pendingBlock(region: RecognitionRegion, destination: ConversionDestination): string[] {
  return [
    '> [!question] Región pendiente de reconocimiento',
    '> No se pudo interpretar como texto, ecuación o tabla. Se conserva la referencia gráfica.',
    '',
    `![[${destination.assetFolder}/${regionAssetFileName(region.id)}]]`,
    '',
  ];
}

function tableBlock(headers: readonly string[], rows: readonly (readonly string[])[]): string[] | null {
  if (headers.length === 0 || rows.length === 0) return null;
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => {
      const cells = headers.map((_, index) => escapeCell(row[index] ?? ''));
      return `| ${cells.join(' | ')} |`;
    }),
    '',
  ];
}

function contentFor(document: IntermediateDocument, regionId: string): RegionContent | undefined {
  return document.regions.find((entry) => entry.regionId === regionId)?.content;
}

function embed(region: RecognitionRegion, destination: ConversionDestination, caption?: string): string {
  const alt = caption?.trim() || `Trazos de ${region.id}`;
  return `![[${destination.assetFolder}/${regionAssetFileName(region.id)}|${alt}]]`;
}

function renderRegion(
  region: RecognitionRegion,
  kind: RegionKind,
  content: RegionContent | undefined,
  destination: ConversionDestination,
  latexOverrides?: ReadonlyMap<string, string>,
): string[] {
  switch (kind) {
    case 'text': {
      const text = content?.text?.trim();
      return text ? [text, ''] : pendingBlock(region, destination);
    }
    case 'math': {
      // A user correction in the preview wins over the engine's reading for this region.
      const latex = (latexOverrides?.get(region.id) ?? content?.latex ?? '').trim();
      return latex ? ['$$', latex, '$$', ''] : pendingBlock(region, destination);
    }
    case 'table': {
      const table = content ? tableBlock(content.headers ?? [], content.rows ?? []) : null;
      return table ?? pendingBlock(region, destination);
    }
    case 'graphic':
      return [embed(region, destination, content?.caption), ''];
    case 'unknown':
      return [embed(region, destination, content?.caption), ''];
  }
}

/**
 * Builds the final note body. Diagnostics, stroke counts, engine warnings and the full-page
 * reference never reach this output: only Markdown content and, when unavoidable, region SVGs.
 */
export function assembleMarkdown(
  document: IntermediateDocument,
  regions: readonly RecognitionRegion[],
  classification: ConversionClassification,
  destination: ConversionDestination,
  latexOverrides?: ReadonlyMap<string, string>,
): string {
  const lines = destination.mode === 'append' ? [] : [...frontmatter(document), ''];
  for (const region of sortedRegions(regions)) {
    const kind = effectiveKind(region, classification);
    if (kind === 'unknown') {
      lines.push(...pendingBlock(region, destination));
      continue;
    }
    lines.push(...renderRegion(region, kind, contentFor(document, region.id), destination, latexOverrides));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
