import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecognitionSnapshot } from '../src/domain/recognition';
import { CanvasReferenceRenderer } from '../src/infrastructure/recognition/reference-renderer';
import { SvgRegionExporter } from '../src/infrastructure/recognition/region-svg-exporter';

const snapshot: RecognitionSnapshot = {
  sourcePath: 'Blackboard/test.blackboard',
  sourceVersion: 3,
  fingerprint: 'abc',
  width: 100,
  height: 100,
  contentBounds: { x: 8, y: 8, width: 84, height: 84 },
  strokes: [
    { id: 'red', tool: 'pen', color: '#ff0000', size: 4, opacity: 1, points: [[10, 10, 0.5], [30, 30, 0.5]], hasPressure: false, timestamp: 1 },
    { id: 'blue', tool: 'pen', color: '#0000ff', size: 4, opacity: 1, points: [[70, 70, 0.5], [90, 90, 0.5]], hasPressure: false, timestamp: 2 },
  ],
};

describe('CanvasReferenceRenderer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders to an off-DOM canvas and returns PNG bytes', async () => {
    const context = {
      fillStyle: '', globalAlpha: 1,
      fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), scale: vi.fn(), translate: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } as Blob);
    });

    const result = await new CanvasReferenceRenderer().render(snapshot, new AbortController().signal);

    expect(Array.from(new Uint8Array(result.data))).toEqual([137, 80, 78, 71]);
    expect(result.width).toBeGreaterThan(0);
    expect(context.fill).toHaveBeenCalledTimes(2);
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('adds padding, preserves aspect ratio, and caps large surfaces without cropping', async () => {
    const context = {
      fillStyle: '', globalAlpha: 1,
      fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), scale: vi.fn(), translate: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } as Blob);
    });
    const large = {
      ...snapshot,
      contentBounds: { x: -500, y: 120, width: 4000, height: 1000 },
    };

    const result = await new CanvasReferenceRenderer().render(large, new AbortController().signal);

    expect(result.width).toBe(2048);
    expect(result.height).toBeLessThanOrEqual(2048);
    // Canvas dimensions are integer pixels, so the final ceil may shift the ratio slightly.
    expect(result.width / result.height).toBeCloseTo(4040 / 1040, 1);
    expect(context.translate).toHaveBeenCalledWith(520, -100);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, result.width, result.height);
    expect(context.fillStyle).toBe('#000000');
  });

  it('fails explicitly when canvas export returns no blob', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '', globalAlpha: 1,
      fillRect() {}, save() {}, restore() {}, scale() {}, translate() {}, beginPath() {},
      moveTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {},
    } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(null));
    await expect(
      new CanvasReferenceRenderer().render(snapshot, new AbortController().signal),
    ).rejects.toThrow('PNG export returned no data');
  });
});

describe('SvgRegionExporter', () => {
  it('exports only the stroke identifiers assigned to a region', () => {
    const svg = new SvgRegionExporter().export(snapshot, {
      id: 'region-001',
      bounds: { x: 8, y: 8, width: 24, height: 24 },
      strokeIds: ['red'],
      kind: 'unknown',
      readingOrder: 0,
    });
    expect(svg).toContain('#ff0000');
    expect(svg).not.toContain('#0000ff');
  });
});
