import type {
  ConversionDestination,
  ConversionDiagnostics,
  ConversionDraft,
  ConversionTarget,
  OutputAsset,
  ProgressReporter,
  RecognitionEngine,
  RegionAssetExporter,
  RegionDiagnostic,
} from '../../domain/recognition';
import { createRecognitionSnapshot } from './snapshot';
import { segmentSnapshot, wholePageRegion } from './segmentation';
import { buildRegionAssets } from './assets';
import { assembleMarkdown } from './markdown-assembler';
import { initialClassification } from './render-conversion';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Conversion cancelled.', 'AbortError');
}

export class ConvertBlackboardUseCase {
  constructor(
    private regionExporter: RegionAssetExporter,
    private engine: RecognitionEngine,
  ) {}

  async execute(
    target: ConversionTarget,
    destination: ConversionDestination,
    signal: AbortSignal,
    report: ProgressReporter = () => {},
  ): Promise<ConversionDraft> {
    const startedAt = Date.now();
    report({ stage: 'snapshot', completed: 0, total: 4, message: 'Capturando trazos…' });
    throwIfAborted(signal);
    const snapshot = await createRecognitionSnapshot(target.getSourcePath(), target.getFile());

    if (snapshot.strokes.length === 0) {
      throw new Error('La superficie no contiene trazos para reconocer.');
    }

    const resolvedDestination: ConversionDestination = destination.mode === 'append'
      ? { ...destination, idempotencyKey: snapshot.fingerprint }
      : destination;

    report({ stage: 'segment', completed: 1, total: 4, message: 'Separando regiones…' });
    throwIfAborted(signal);
    const regions = this.engine.inputMode === 'page'
      ? wholePageRegion(snapshot)
      : segmentSnapshot(snapshot);

    report({ stage: 'recognize', completed: 2, total: 4, message: `Ejecutando ${this.engine.id}…` });
    throwIfAborted(signal);
    const document = await this.engine.recognize(snapshot, regions, signal);

    report({ stage: 'assemble', completed: 3, total: 4, message: 'Ensamblando Markdown…' });
    throwIfAborted(signal);
    const classification = initialClassification(document);
    const markdown = assembleMarkdown(document, regions, classification, resolvedDestination);
    const assets: OutputAsset[] = buildRegionAssets(snapshot, regions, classification, this.regionExporter);

    const diagnostics: ConversionDiagnostics = {
      engineId: document.engineId,
      simulated: document.simulated,
      fingerprint: snapshot.fingerprint,
      durationMs: Date.now() - startedAt,
      strokeCount: snapshot.strokes.length,
      regionCount: regions.length,
      regions: regions.map((region): RegionDiagnostic => {
        const recognition = document.regions.find((entry) => entry.regionId === region.id)?.content;
        const kind = classification.get(region.id) ?? 'unknown';
        return {
          regionId: region.id,
          readingOrder: region.readingOrder,
          strokeCount: region.strokeIds.length,
          bounds: region.bounds,
          kind,
          engineKind: recognition?.kind ?? 'unknown',
          engineId: document.engineId,
          simulated: document.simulated,
          confidence: recognition?.confidence,
          note: kind === 'unknown' ? 'Pendiente de reconocimiento' : undefined,
        };
      }),
      warnings: document.warnings,
    };

    report({ stage: 'assemble', completed: 4, total: 4, message: 'Vista previa lista.' });
    return { destination: resolvedDestination, snapshot, document, regions, markdown, assets, diagnostics };
  }
}
