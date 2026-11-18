import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { BlackboardFile, Stroke } from '../src/domain/entities';
import type {
  ConversionDestination,
  ConversionTarget,
  IntermediateDocument,
  RecognitionEngine,
  RecognitionRegion,
  RecognitionSnapshot,
  RegionAssetExporter,
} from '../src/domain/recognition';
import { createRecognitionSnapshot } from '../src/application/recognition/snapshot';
import { segmentSnapshot } from '../src/application/recognition/segmentation';
import { DeterministicMockEngine } from '../src/application/recognition/mock-engine';
import { ConvertBlackboardUseCase } from '../src/application/recognition/convert-blackboard';
import { renderConversion, initialClassification } from '../src/application/recognition/render-conversion';

beforeAll(() => {
  if (!window.crypto?.subtle) Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
});

function stroke(id: string, x: number, y: number, points?: Array<[number, number, number]>): Stroke {
  return {
    id,
    tool: 'pen',
    color: '#ffffff',
    size: 4,
    opacity: 1,
    points: points ?? [[x, y, 0.5], [x + 20, y + 10, 0.5]],
    hasPressure: false,
    timestamp: 100,
  };
}

function file(strokes: Stroke[] = []): BlackboardFile {
  return { version: 3, width: 800, height: 600, strokes, background: { color: 'transparent' } };
}

class FakeRegionExporter implements RegionAssetExporter {
  export(_snapshot: RecognitionSnapshot, region: { id: string }): string {
    return `<svg data-region="${region.id}"></svg>`;
  }
}

class FakePageEngine implements RecognitionEngine {
  readonly id = 'page-engine';
  readonly inputMode = 'page' as const;
  seenRegions: readonly RecognitionRegion[] = [];

  async recognize(
    snapshot: RecognitionSnapshot,
    regions: readonly RecognitionRegion[],
  ): Promise<IntermediateDocument> {
    this.seenRegions = regions;
    return {
      sourcePath: snapshot.sourcePath,
      sourceFingerprint: snapshot.fingerprint,
      engineId: this.id,
      simulated: false,
      regions: [{ regionId: regions[0].id, content: { kind: 'text', text: 'Texto\n\n$$x^2$$' } }],
      warnings: [],
    };
  }
}

const destination: ConversionDestination = {
  notePath: 'Blackboard/example - convertido.md',
  assetFolder: 'Blackboard/example - convertido-assets',
};

function pipeline(exporter: RegionAssetExporter = new FakeRegionExporter()) {
  return new ConvertBlackboardUseCase(exporter, new DeterministicMockEngine());
}

function target(drawing: BlackboardFile): ConversionTarget {
  return { getSourcePath: () => 'Blackboard/example.blackboard', getFile: () => drawing };
}

describe('recognition snapshot', () => {
  it('is deeply immutable and preserves every stroke property', async () => {
    const drawing = file([stroke('a', 10, 20)]);
    const snapshot = await createRecognitionSnapshot('Blackboard/example.blackboard', drawing);

    expect(snapshot.strokes[0]).toMatchObject({ id: 'a', color: '#ffffff', size: 4, opacity: 1, timestamp: 100 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.strokes[0].points[0])).toBe(true);
    drawing.strokes[0].points[0][0] = 999;
    expect(snapshot.strokes[0].points[0][0]).toBe(10);
  });

  it('produces the same fingerprint for repeated identical content', async () => {
    const drawing = file([stroke('a', 10, 20)]);
    const first = await createRecognitionSnapshot('Blackboard/example.blackboard', drawing);
    const second = await createRecognitionSnapshot('Blackboard/example.blackboard', JSON.parse(JSON.stringify(drawing)));
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the content fingerprint stable when only the source path changes', async () => {
    const drawing = file([stroke('a', 10, 20)]);
    const first = await createRecognitionSnapshot('Blackboard/old.blackboard', drawing);
    const renamed = await createRecognitionSnapshot('Archive/new.blackboard', drawing);
    expect(renamed.fingerprint).toBe(first.fingerprint);
  });

  it('reads the target path lazily, after Obsidian has assigned the view file', async () => {
    let path = '';
    const drawing = file([stroke('a', 0, 0)]);
    const lazy: ConversionTarget = { getSourcePath: () => path, getFile: () => drawing };
    path = 'Blackboard/opened-later.blackboard';
    const draft = await pipeline().execute(lazy, destination, new AbortController().signal);
    expect(draft.snapshot.sourcePath).toBe('Blackboard/opened-later.blackboard');
  });
});

describe('deterministic conversion pipeline', () => {
  it('rejects an empty board before invoking recognition', async () => {
    await expect(
      pipeline().execute(target(file()), destination, new AbortController().signal),
    ).rejects.toThrow('no contiene trazos');
  });

  it('exports handwritten-text regions as Markdown only', async () => {
    const draft = await pipeline().execute(target(file([stroke('word', 10, 10)])), destination, new AbortController().signal);
    expect(draft.markdown).toContain('Texto de muestra de la región 1.');
    expect(draft.markdown).not.toContain('.svg');
    expect(draft.assets).toEqual([]);
  });

  it('exports equations as LaTeX only and never duplicates them as images', async () => {
    const drawing = file([stroke('formula-a', 10, 10), stroke('formula-b', 300, 10)]);
    const draft = await pipeline().execute(target(drawing), destination, new AbortController().signal);
    expect(draft.markdown).toContain('$$\nx_{2}^{2} + y_{2}^{2} = r^{2}\n$$');
    expect(draft.markdown).not.toContain('.svg');
    expect(draft.document.simulated).toBe(true);
  });

  it('segments multiple regions in stable reading order and exports only the pending one', async () => {
    const drawing = file([
      stroke('b', 300, 200),
      stroke('a', 10, 10),
      stroke('c', 10, 400),
      stroke('d', 300, 400),
    ]);
    const snapshot = await createRecognitionSnapshot('Blackboard/example.blackboard', drawing);
    const regions = segmentSnapshot(snapshot);
    expect(regions.map((region) => region.strokeIds[0])).toEqual(['a', 'b', 'c', 'd']);

    const draft = await pipeline().execute(target(drawing), destination, new AbortController().signal);
    expect(draft.assets.map((asset) => asset.fileName)).toEqual(['region-004.svg']);
    expect(draft.markdown).toContain('| Elemento | Cantidad |');
    expect(draft.markdown).toContain('> [!question] Región pendiente de reconocimiento');
    expect(draft.markdown).toContain('![[Blackboard/example - convertido-assets/region-004.svg]]');
    expect(draft.diagnostics.regions.map((region) => region.kind)).toEqual(['text', 'math', 'table', 'unknown']);
  });

  it('uses only surviving stroke fragments after erasing', async () => {
    const drawing = file([stroke('line~0', 10, 10), stroke('line~1', 200, 10)]);
    const draft = await pipeline().execute(target(drawing), destination, new AbortController().signal);
    expect(draft.snapshot.strokes.map((item) => item.id)).toEqual(['line~0', 'line~1']);
    expect(draft.snapshot.strokes.some((item) => item.id === 'line')).toBe(false);
  });

  it('repeats identical content with identical fingerprint and Markdown', async () => {
    const drawing = file([stroke('same', 10, 10)]);
    const first = await pipeline().execute(target(drawing), destination, new AbortController().signal);
    const second = await pipeline().execute(target(drawing), destination, new AbortController().signal);
    expect(second.snapshot.fingerprint).toBe(first.snapshot.fingerprint);
    expect(second.markdown).toBe(first.markdown);
  });

  it('cancels between pipeline stages', async () => {
    const controller = new AbortController();
    const promise = pipeline().execute(target(file([stroke('a', 0, 0)])), destination, controller.signal, (progress) => {
      if (progress.stage === 'segment') controller.abort();
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports an export failure and does not continue', async () => {
    const exporter: RegionAssetExporter = {
      export: () => { throw new Error('forced SVG failure'); },
    };
    const drawing = file([
      stroke('a', 10, 10), stroke('b', 300, 10), stroke('c', 10, 400), stroke('d', 300, 400),
    ]);
    await expect(
      pipeline(exporter).execute(target(drawing), destination, new AbortController().signal),
    ).rejects.toThrow('forced SVG failure');
  });

  it('leaves the source Blackboard file byte-for-byte equivalent', async () => {
    const drawing = file([stroke('original', 10, 10)]);
    const before = JSON.stringify(drawing);
    await pipeline().execute(target(drawing), destination, new AbortController().signal);
    expect(JSON.stringify(drawing)).toBe(before);
  });
});

describe('page OCR pipeline', () => {
  it('renders the whole surface as one page and prepares insertion without frontmatter', async () => {
    const pageEngine = new FakePageEngine();
    const useCase = new ConvertBlackboardUseCase(new FakeRegionExporter(), pageEngine);
    const drawing = file([stroke('far-a', 10, 10), stroke('far-b', 700, 500)]);
    const insertion: ConversionDestination = {
      notePath: 'Clases/Nota.md',
      assetFolder: 'Clases/Nota OCR-assets',
      mode: 'append',
    };

    const draft = await useCase.execute(target(drawing), insertion, new AbortController().signal);

    expect(pageEngine.seenRegions).toHaveLength(1);
    expect(pageEngine.seenRegions[0].strokeIds).toEqual(['far-a', 'far-b']);
    expect(draft.markdown).toBe('Texto\n\n$$x^2$$\n');
    expect(draft.markdown).not.toContain('caelestia_source');
    expect(draft.destination.idempotencyKey).toBe(draft.snapshot.fingerprint);
    expect(draft.assets).toEqual([]);
  });
});

describe('classification corrections', () => {
  it('turns a text region into an SVG embed when the user overrides it', async () => {
    const draft = await pipeline().execute(target(file([stroke('word', 10, 10)])), destination, new AbortController().signal);
    const rendered = renderConversion(
      draft,
      new Map([['region-001', 'graphic']]),
      new FakeRegionExporter(),
    );

    expect(rendered.assets.map((asset) => asset.fileName)).toEqual(['region-001.svg']);
    expect(rendered.markdown).toContain('![[Blackboard/example - convertido-assets/region-001.svg|');
    expect(rendered.markdown).not.toContain('Texto de muestra');
  });

  it('drops the SVG when a pending region is corrected to text without a transcription', async () => {
    const drawing = file([
      stroke('a', 10, 10), stroke('b', 300, 10), stroke('c', 10, 400), stroke('d', 300, 400),
    ]);
    const draft = await pipeline().execute(target(drawing), destination, new AbortController().signal);
    const kinds = initialClassification(draft.document);
    kinds.set('region-004', 'text');
    const rendered = renderConversion(draft, kinds, new FakeRegionExporter());

    expect(rendered.assets).toEqual([]);
    expect(rendered.markdown).toContain('Región pendiente de reconocimiento');
  });
});
