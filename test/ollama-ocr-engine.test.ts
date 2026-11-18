import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { OllamaOcrEngine } from '../src/infrastructure/recognition/ollama-ocr-engine';
import type {
  RecognitionRegion,
  RecognitionSnapshot,
  ReferenceRenderer,
} from '../src/domain/recognition';

const snapshot: RecognitionSnapshot = {
  sourcePath: 'Blackboard/clase.blackboard',
  sourceVersion: 3,
  fingerprint: 'abc123',
  width: 800,
  height: 600,
  contentBounds: { x: 10, y: 20, width: 400, height: 200 },
  strokes: [{
    id: 'stroke-1',
    tool: 'pen',
    color: '#ffffff',
    size: 4,
    opacity: 1,
    points: [[10, 20, 0.5], [40, 60, 0.5]],
    hasPressure: false,
    timestamp: 1,
  }],
};

const page: RecognitionRegion = {
  id: 'page-001',
  bounds: snapshot.contentBounds,
  strokeIds: ['stroke-1'],
  kind: 'unknown',
  readingOrder: 0,
};

function response(status: number, json: unknown): any {
  return { status, json, text: JSON.stringify(json), headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

function renderer(): ReferenceRenderer & { render: ReturnType<typeof vi.fn> } {
  return {
    render: vi.fn(async () => ({
      data: new Uint8Array([137, 80, 78, 71]).buffer,
      width: 800,
      height: 400,
      contentBounds: snapshot.contentBounds,
    })),
  };
}

function engine(imageRenderer = renderer(), overrides: Partial<ConstructorParameters<typeof OllamaOcrEngine>[1]> = {}) {
  return new OllamaOcrEngine(imageRenderer, {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'glm-ocr:q8_0',
    timeoutMs: 180_000,
    maxRetries: 3,
    ...overrides,
  });
}

describe('OllamaOcrEngine', () => {
  beforeEach(() => {
    vi.mocked(requestUrl).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates the installed model and sends one local multimodal request', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(200, { models: [{ name: 'glm-ocr:q8_0' }] }))
      .mockResolvedValueOnce(response(200, {
        message: { content: '```markdown\nTexto\n$$x^2$$\n```' },
      }));
    const imageRenderer = renderer();

    const result = await engine(imageRenderer).recognize(snapshot, [page], new AbortController().signal);

    expect(result.engineId).toBe('ollama-glm-ocr');
    expect(result.simulated).toBe(false);
    expect(result.regions).toEqual([{ regionId: 'page-001', content: { kind: 'text', text: 'Texto\n$$x^2$$' } }]);
    expect(imageRenderer.render).toHaveBeenCalledOnce();
    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestUrl).mock.calls[0][0].url).toBe('http://127.0.0.1:11434/api/tags');
    const recognition = vi.mocked(requestUrl).mock.calls[1][0];
    expect(recognition.url).toBe('http://127.0.0.1:11434/api/chat');
    const payload = JSON.parse(recognition.body as string);
    expect(payload.model).toBe('glm-ocr:q8_0');
    expect(payload.messages[0].images[0]).toBe('iVBORw==');
    expect(payload.messages[0].content).toContain('do not solve');
    expect(payload.options).toEqual({ num_ctx: 8192, num_predict: 2000, temperature: 0 });
  });

  it('stops before rendering when the configured model is unavailable', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { models: [{ name: 'other' }] }));
    const imageRenderer = renderer();

    await expect(engine(imageRenderer).recognize(snapshot, [page], new AbortController().signal))
      .rejects.toThrow('no está disponible');
    expect(imageRenderer.render).not.toHaveBeenCalled();
    expect(vi.mocked(requestUrl)).toHaveBeenCalledOnce();
  });

  it('reports a disconnected local server clearly', async () => {
    vi.mocked(requestUrl).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(engine().recognize(snapshot, [page], new AbortController().signal))
      .rejects.toThrow('No se pudo conectar con Ollama');
  });

  it('retries temporary server errors but not model validation errors', async () => {
    vi.useFakeTimers();
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(200, { models: [{ model: 'glm-ocr:q8_0' }] }))
      .mockResolvedValueOnce(response(500, { error: 'temporary' }))
      .mockResolvedValueOnce(response(200, { message: { content: 'resultado' } }));

    const pending = engine().recognize(snapshot, [page], new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      regions: [{ content: { text: 'resultado' } }],
    });
    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(3);
  });

  it('reports native Ollama errors without retrying a bad request', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(200, { models: [{ name: 'glm-ocr:q8_0' }] }))
      .mockResolvedValueOnce(response(400, { error: 'invalid request' }));

    await expect(engine().recognize(snapshot, [page], new AbortController().signal))
      .rejects.toThrow('HTTP 400): invalid request');
    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(2);
  });

  it('honours cancellation before any network request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(engine().recognize(snapshot, [page], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(requestUrl)).not.toHaveBeenCalled();
  });

  it('cancels a pending recognition without accepting its eventual result', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(200, { models: [{ name: 'glm-ocr:q8_0' }] }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = engine().recognize(snapshot, [page], controller.signal);
    await vi.waitFor(() => expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(2);
  });

  it('rejects non-local endpoints', () => {
    expect(() => engine(renderer(), { baseUrl: 'https://example.com/v1' }))
      .toThrow('HTTP local');
  });

  it('refuses any model other than the validated local Q8 variant', () => {
    expect(() => engine(renderer(), { model: 'glm-ocr:bf16' }))
      .toThrow('solo permite');
  });
});
