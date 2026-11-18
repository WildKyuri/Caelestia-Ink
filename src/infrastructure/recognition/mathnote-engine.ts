// This module only loads on desktop: main.ts imports it from a `Platform.isDesktopApp`
// branch and only when a Python path is configured, so the Node built-ins never reach the
// mobile bundle. Its timers belong to the Node sidecar, not to an Obsidian popout window.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type {
  IntermediateDocument,
  RecognitionEngine,
  RecognitionRegion,
  RecognitionSnapshot,
  RegionRecognition,
} from '../../domain/recognition';
import { MATHNOTE_SIDECAR_SOURCE } from './mathnote-sidecar-source';

/** Wire protocol between the plugin and the local Python sidecar. Bump with the Python file. */
export const MATHNOTE_PROTOCOL_VERSION = 1;

/** Engine id reported in the intermediate document and the diagnostics panel. */
export const MATHNOTE_ENGINE_ID = 'mathnote-ocr-0.2.1';

const MAX_POINTS_PER_REGION = 60000;
const MAX_STROKES_PER_REGION = 4000;

/** Structural subset of `child_process.ChildProcess` used here, so tests can inject a fake. */
export interface SidecarProcess {
  stdin: { write(chunk: string): unknown; end(): unknown };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SidecarSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    stdio: readonly ['pipe', 'pipe', 'pipe'];
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => SidecarProcess;

export interface MathNoteEngineOptions {
  /** Interpreter that has mathnote-ocr installed. Never taken from board content. */
  pythonPath: string;
  /** Per-region wait. A conversion of many regions can take several seconds in total. */
  timeoutMs?: number;
  /** Below this, the region stays pending and keeps its SVG. */
  minimumConfidence?: number;
  /** Fraction of region strokes the engine left unexplained that is still acceptable. */
  maxUnexplainedRatio?: number;
  /** Injection point for tests; production uses node's spawn. */
  spawnSidecar?: SidecarSpawn;
  /** Working directory for the sidecar; defaults to the OS temp folder (never the vault). */
  workingDirectory?: string;
}

interface SidecarAnswer {
  protocol?: number;
  id?: string;
  ok: boolean;
  latex?: string;
  confidence?: number;
  symbols?: number;
  unexplained?: number;
  grouping?: number | null;
  durationMs?: number;
  error?: string;
}

interface PendingRequest {
  resolve: (answer: SidecarAnswer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_MAX_UNEXPLAINED_RATIO = 0.15;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Conversion cancelled.', 'AbortError');
}

/**
 * Real math recognizer. Reads the vector strokes already stored in the `.blackboard` file,
 * sends them to a local Python process and turns the answer into a region's LaTeX.
 *
 * Boundaries:
 * - Only numbers travel over the pipe: no file paths, no note text, no commands.
 * - The sidecar is started from an embedded source string; nothing is read from the vault.
 * - One process serves one conversion and is killed in `finally`, on error and on cancel.
 * - A region whose answer is incomplete or unconfident stays `unknown`, so the assembler
 *   keeps its SVG and marks it pending instead of writing guessed LaTeX.
 */
export class MathNoteEngine implements RecognitionEngine {
  readonly id = MATHNOTE_ENGINE_ID;
  private readonly timeoutMs: number;
  private readonly minimumConfidence: number;
  private readonly maxUnexplainedRatio: number;
  private readonly spawnSidecar: SidecarSpawn;
  private readonly workingDirectory: string;

  constructor(private options: MathNoteEngineOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minimumConfidence = options.minimumConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.maxUnexplainedRatio = options.maxUnexplainedRatio ?? DEFAULT_MAX_UNEXPLAINED_RATIO;
    this.spawnSidecar = options.spawnSidecar ?? (spawn as unknown as SidecarSpawn);
    this.workingDirectory = options.workingDirectory ?? tmpdir();
  }

  async recognize(
    snapshot: RecognitionSnapshot,
    regions: readonly RecognitionRegion[],
    signal: AbortSignal,
  ): Promise<IntermediateDocument> {
    throwIfAborted(signal);
    const warnings: string[] = [];
    const results: RegionRecognition[] = [];
    if (regions.length === 0) {
      return {
        sourcePath: snapshot.sourcePath,
        sourceFingerprint: snapshot.fingerprint,
        engineId: this.id,
        simulated: false,
        regions: [],
        warnings,
      };
    }

    const client = new SidecarClient(
      this.options.pythonPath,
      this.spawnSidecar,
      this.workingDirectory,
      this.timeoutMs,
      signal,
    );
    try {
      client.start();
      for (const region of regions) {
        throwIfAborted(signal);
        const strokes = this.regionStrokes(snapshot, region, warnings);
        if (!strokes) {
          results.push({ regionId: region.id, content: { kind: 'unknown' } });
          continue;
        }
        let answer: SidecarAnswer;
        try {
          answer = await client.detect(region.id, strokes);
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`${region.id}: el motor no respondió (${message}).`);
          results.push({ regionId: region.id, content: { kind: 'unknown' } });
          continue;
        }
        results.push(this.toRegionRecognition(region, strokes.length, answer, warnings));
      }
    } finally {
      client.close();
    }

    return {
      sourcePath: snapshot.sourcePath,
      sourceFingerprint: snapshot.fingerprint,
      engineId: this.id,
      simulated: false,
      regions: results,
      warnings,
    };
  }

  /**
   * Vector points of one region, in stored order. Coordinates are canvas pixels rounded to
   * two decimals (the engine normalizes scale itself); no reordering, smoothing or
   * segmentation is applied, so the LaTeX corresponds to the strokes the user sees.
   */
  private regionStrokes(
    snapshot: RecognitionSnapshot,
    region: RecognitionRegion,
    warnings: string[],
  ): number[][][] | null {
    if (region.strokeIds.length === 0 || region.strokeIds.length > MAX_STROKES_PER_REGION) {
      warnings.push(`${region.id}: región vacía o demasiado grande para el motor.`);
      return null;
    }
    const byId = new Map(snapshot.strokes.map((stroke) => [stroke.id, stroke]));
    const strokes: number[][][] = [];
    let points = 0;
    for (const id of region.strokeIds) {
      const stroke = byId.get(id);
      if (!stroke) continue;
      const converted = stroke.points.map((point) => [
        Math.round(point[0] * 100) / 100,
        Math.round(point[1] * 100) / 100,
      ]);
      points += converted.length;
      if (points > MAX_POINTS_PER_REGION) {
        warnings.push(`${region.id}: demasiados puntos para el motor.`);
        return null;
      }
      strokes.push(converted);
    }
    return strokes.length > 0 ? strokes : null;
  }

  private toRegionRecognition(
    region: RecognitionRegion,
    strokeCount: number,
    answer: SidecarAnswer,
    warnings: string[],
  ): RegionRecognition {
    if (!answer.ok) {
      warnings.push(`${region.id}: ${answer.error ?? 'el motor devolvió un error.'}`);
      return { regionId: region.id, content: { kind: 'unknown' } };
    }
    const latex = (answer.latex ?? '').trim();
    if (!latex) {
      warnings.push(`${region.id}: el motor no devolvió LaTeX.`);
      return { regionId: region.id, content: { kind: 'unknown' } };
    }
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
    const unexplained = answer.unexplained ?? 0;
    const ratio = strokeCount > 0 ? unexplained / strokeCount : 1;
    if (confidence < this.minimumConfidence || ratio > this.maxUnexplainedRatio) {
      warnings.push(
        `${region.id}: resultado descartado (confianza ${confidence.toFixed(2)}, ` +
          `${unexplained}/${strokeCount} trazos sin explicar). Se conserva el SVG.`,
      );
      return { regionId: region.id, content: { kind: 'unknown' } };
    }
    if (unexplained > 0) {
      warnings.push(`${region.id}: ${unexplained} de ${strokeCount} trazos quedaron sin explicar.`);
    }
    return { regionId: region.id, content: { kind: 'math', latex, confidence } };
  }
}

/**
 * One Python process, one JSON line per request. Answers are matched by region id, so a late
 * answer can never be attached to a different region.
 */
class SidecarClient {
  private child: SidecarProcess | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private stderrText = '';
  private closed = false;
  private onAbort: (() => void) | null = null;

  constructor(
    private pythonPath: string,
    private spawnSidecar: SidecarSpawn,
    private workingDirectory: string,
    private timeoutMs: number,
    private signal: AbortSignal,
  ) {}

  start(): void {
    if (this.child) return;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    };
    delete env.PYTHONPATH;
    // `-c` keeps the sidecar off the filesystem; `-u` makes each answer arrive immediately.
    this.child = this.spawnSidecar(this.pythonPath, ['-u', '-c', MATHNOTE_SIDECAR_SOURCE], {
      cwd: this.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderrText = `${this.stderrText}${chunk.toString()}`.slice(-4000);
    });
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('exit', (code) => {
      if (this.closed) return;
      const detail = this.stderrText.trim().split('\n').pop();
      this.failAll(
        new Error(
          `el proceso de reconocimiento terminó (código ${code ?? 'null'})` +
            (detail ? `: ${detail}` : ''),
        ),
      );
    });
    this.onAbort = () => {
      this.failAll(new DOMException('Conversion cancelled.', 'AbortError'));
      this.close();
    };
    this.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  detect(id: string, strokes: number[][][]): Promise<SidecarAnswer> {
    return new Promise<SidecarAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sin respuesta en ${this.timeoutMs} ms`));
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ protocol: MATHNOTE_PROTOCOL_VERSION, op: 'detect', id, strokes });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.onAbort) this.signal.removeEventListener('abort', this.onAbort);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new DOMException('Conversion cancelled.', 'AbortError'));
    }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // The pipe may already be gone; killing the process is what matters.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
  }

  private write(payload: unknown): void {
    if (!this.child) throw new Error('el proceso de reconocimiento no está activo');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let answer: SidecarAnswer;
    try {
      answer = JSON.parse(line) as SidecarAnswer;
    } catch {
      this.failAll(new Error(`respuesta ilegible: ${line.slice(0, 160)}`));
      return;
    }
    if (answer.protocol !== MATHNOTE_PROTOCOL_VERSION) {
      this.failAll(new Error(`protocolo incompatible: ${String(answer.protocol)}`));
      return;
    }
    if (answer.id === undefined) return; // ping acknowledgement
    const entry = this.pending.get(answer.id);
    if (!entry) return;
    this.pending.delete(answer.id);
    clearTimeout(entry.timer);
    entry.resolve(answer);
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
