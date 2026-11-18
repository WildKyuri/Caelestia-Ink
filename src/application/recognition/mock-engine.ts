import type {
  IntermediateDocument,
  RecognitionEngine,
  RecognitionRegion,
  RecognitionSnapshot,
  RegionRecognition,
} from '../../domain/recognition';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Conversion cancelled.', 'AbortError');
}

/**
 * DEVELOPMENT ONLY. Registered behind __DEV_BUILD__ so release builds cannot produce notes
 * that look recognized. Its content is explicitly sample data, never a transcription.
 */
export class DeterministicMockEngine implements RecognitionEngine {
  readonly id = 'caelestia-mock-v1';

  async recognize(
    snapshot: RecognitionSnapshot,
    regions: readonly RecognitionRegion[],
    signal: AbortSignal,
  ): Promise<IntermediateDocument> {
    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);
    const recognized: RegionRecognition[] = regions.map((region, index) => {
      switch (index % 4) {
        case 0:
          return {
            regionId: region.id,
            content: { kind: 'text', text: `Texto de muestra de la región ${index + 1}.`, confidence: 0.5 },
          };
        case 1:
          return {
            regionId: region.id,
            content: { kind: 'math', latex: `x_{${index + 1}}^{2} + y_{${index + 1}}^{2} = r^{2}`, confidence: 0.5 },
          };
        case 2:
          return {
            regionId: region.id,
            content: {
              kind: 'table',
              headers: ['Elemento', 'Cantidad'],
              rows: [['Ejemplo A', '1'], ['Ejemplo B', '2']],
              confidence: 0.5,
            },
          };
        default:
          return {
            regionId: region.id,
            content: { kind: 'unknown', caption: `Trazos sin clasificar de ${region.id}` },
          };
      }
    });
    return {
      sourcePath: snapshot.sourcePath,
      sourceFingerprint: snapshot.fingerprint,
      engineId: this.id,
      simulated: true,
      regions: recognized,
      warnings: ['Motor de desarrollo: el contenido es de muestra y no proviene de reconocimiento manuscrito.'],
    };
  }
}
