import { requestUrl } from 'obsidian';
import type {
  IntermediateDocument,
  RecognitionEngine,
  RecognitionRegion,
  RecognitionSnapshot,
  ReferenceRenderer,
} from '../../domain/recognition';

/**
 * The prompt and bounded retry policy are adapted from kkbin505/pdf-to-md (MIT), commit
 * b0de779. Transport uses Ollama's native API so the required context can be set per request.
 * PDF rendering, compression and vault-writing code from that plugin are not copied.
 */

export interface OllamaOcrOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

interface OllamaModelTag {
  name?: string;
  model?: string;
}

interface OllamaChatResponse {
  message?: { content?: unknown };
  error?: unknown;
}

const OCR_PROMPT = `Transcribe only the visible content of this handwritten page as Markdown.
Requirements:
1. Preserve the reading order and the original text; do not solve, correct, or explain exercises.
2. Convert mathematical expressions to Obsidian-compatible LaTeX using $...$ or $$...$$.
3. Preserve tables as Markdown when their structure is clear.
4. Do not invent illegible content. Use [ilegible] only where content cannot be read.
5. Output only Markdown, without commentary or code fences.`;

class OllamaOcrError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'OllamaOcrError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Conversión cancelada.', 'AbortError');
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OllamaOcrError('La URL de Ollama no es válida.', false);
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new OllamaOcrError('Ollama debe usar HTTP local en 127.0.0.1 o localhost.', false);
  }
  if (url.port && url.port !== '11434') {
    throw new OllamaOcrError('Ollama debe usar el puerto local 11434.', false);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/v1') {
    throw new OllamaOcrError('La URL de Ollama no puede incluir una ruta distinta de /v1.', false);
  }
  return url.origin;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeMarkdown(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OllamaOcrError('Ollama devolvió una respuesta sin contenido Markdown.', false);
  }
  let markdown = value.trim();
  const fenced = markdown.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) markdown = fenced[1].trim();
  if (!markdown) throw new OllamaOcrError('Ollama devolvió una respuesta vacía.', false);
  if (markdown.length > 1_000_000) {
    throw new OllamaOcrError('La respuesta de Ollama excede el tamaño permitido.', false);
  }
  return markdown;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel(): void {
      window.clearTimeout(timer);
      reject(new DOMException('Conversión cancelada.', 'AbortError'));
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export class OllamaOcrEngine implements RecognitionEngine {
  readonly id = 'ollama-glm-ocr';
  readonly inputMode = 'page' as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(
    private renderer: ReferenceRenderer,
    options: OllamaOcrOptions,
  ) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.model = options.model.trim();
    this.timeoutMs = Math.min(600_000, Math.max(5_000, Math.round(options.timeoutMs)));
    this.maxRetries = Math.min(3, Math.max(1, Math.round(options.maxRetries)));
    if (this.model !== 'glm-ocr:q8_0') {
      throw new OllamaOcrError('Esta integración solo permite el modelo local glm-ocr:q8_0.', false);
    }
  }

  async recognize(
    snapshot: RecognitionSnapshot,
    regions: readonly RecognitionRegion[],
    signal: AbortSignal,
  ): Promise<IntermediateDocument> {
    throwIfAborted(signal);
    const region = regions[0];
    if (!region) throw new OllamaOcrError('La superficie no contiene una región reconocible.', false);

    await this.ensureModelAvailable(signal);
    const image = await this.renderer.render(snapshot, signal);
    const imageBase64 = arrayBufferToBase64(image.data);
    const markdown = await this.recognizeWithRetry(imageBase64, signal);

    return {
      sourcePath: snapshot.sourcePath,
      sourceFingerprint: snapshot.fingerprint,
      engineId: this.id,
      simulated: false,
      regions: [{ regionId: region.id, content: { kind: 'text', text: markdown } }],
      warnings: [],
    };
  }

  private async ensureModelAvailable(signal: AbortSignal): Promise<void> {
    const tagsUrl = `${new URL(this.baseUrl).origin}/api/tags`;
    let response: Awaited<ReturnType<typeof requestUrl>>;
    try {
      response = await this.withGuards(requestUrl({ url: tagsUrl, method: 'GET', throw: false }), signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (error instanceof OllamaOcrError) throw error;
      throw new OllamaOcrError('No se pudo conectar con Ollama en 127.0.0.1:11434.', true);
    }
    if (response.status >= 400) {
      throw new OllamaOcrError(`Ollama no respondió correctamente (HTTP ${response.status}).`, response.status >= 500);
    }
    const models = (response.json as { models?: OllamaModelTag[] } | undefined)?.models;
    if (!Array.isArray(models)) throw new OllamaOcrError('Ollama devolvió una lista de modelos inválida.', false);
    const available = models.some((entry) => entry.name === this.model || entry.model === this.model);
    if (!available) {
      throw new OllamaOcrError(`El modelo ${this.model} no está disponible en Ollama.`, false);
    }
  }

  private async recognizeWithRetry(imageBase64: string, signal: AbortSignal): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      throwIfAborted(signal);
      try {
        return await this.recognizeOnce(imageBase64, signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof OllamaOcrError ? error.retryable : true;
        if (!retryable || attempt === this.maxRetries) break;
        await abortableDelay(1_000 * attempt, signal);
      }
    }
    throw lastError ?? new OllamaOcrError('Ollama no pudo reconocer la superficie.', false);
  }

  private async recognizeOnce(imageBase64: string, signal: AbortSignal): Promise<string> {
    const payload = {
      model: this.model,
      messages: [{
        role: 'user',
        content: OCR_PROMPT,
        images: [imageBase64],
      }],
      stream: false,
      options: {
        num_ctx: 8192,
        num_predict: 2000,
        temperature: 0,
      },
    };

    let response: Awaited<ReturnType<typeof requestUrl>>;
    try {
      response = await this.withGuards(requestUrl({
        url: `${this.baseUrl}/api/chat`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        throw: false,
      }), signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (error instanceof OllamaOcrError) throw error;
      throw new OllamaOcrError('Se perdió la conexión con Ollama durante el reconocimiento.', true);
    }

    const body = response.json as OllamaChatResponse | undefined;
    if (response.status >= 400) {
      const detail = typeof body?.error === 'string' ? `: ${body.error}` : '';
      throw new OllamaOcrError(
        `Ollama rechazó el reconocimiento (HTTP ${response.status})${detail}`,
        response.status >= 500 || response.status === 429,
      );
    }
    return normalizeMarkdown(body?.message?.content);
  }

  private withGuards<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        callback();
      };
      const cancel = (): void => finish(() => reject(new DOMException('Conversión cancelada.', 'AbortError')));
      const timer = window.setTimeout(() => {
        finish(() => reject(new OllamaOcrError(`Ollama excedió el timeout de ${Math.round(this.timeoutMs / 1000)} s.`, true)));
      }, this.timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      );
      if (signal.aborted) cancel();
    });
  }
}
