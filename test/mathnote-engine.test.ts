import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  RecognitionRegion,
  RecognitionSnapshot,
  SnapshotPoint,
} from '../src/domain/recognition';
import {
  MathNoteEngine,
  MATHNOTE_ENGINE_ID,
  type SidecarProcess,
  type SidecarSpawn,
} from '../src/infrastructure/recognition/mathnote-engine';

/**
 * The engine speaks a line protocol over two pipes. These tests replace the real Python
 * process with a fake one, so the contract (one request per region, answers matched by id,
 * timeouts, cancellation, process death) is verified without needing mathnote-ocr installed.
 */
class FakeChild extends EventEmitter implements SidecarProcess {
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  stdinEnded = false;
  stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.requests.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
  };

  constructor(private onRequest?: (request: Record<string, unknown>, child: FakeChild) => void) {
    super();
    // Route writes through the handler so an answer can be emitted the moment it arrives.
    const originalWrite = this.stdin.write;
    this.stdin.write = (chunk: string) => {
      const result = originalWrite(chunk);
      for (const request of this.requests.slice(-chunk.split('\n').filter((l) => l.trim()).length)) {
        this.onRequest?.(request, this);
      }
      return result;
    };
  }

  reply(payload: Record<string, unknown>): void {
    this.stdout.emit('data', `${JSON.stringify(payload)}\n`);
  }

  crash(code = 1, stderr = ''): void {
    if (stderr) this.stderr.emit('data', stderr);
    this.emit('exit', code, null);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function stroke(id: string, points: readonly [number, number][] = [[0, 0], [10, 10]]) {
  return {
    id,
    tool: 'pen' as const,
    color: '#ffffff',
    size: 2,
    opacity: 1,
    points: points.map(([x, y]) => [x, y, 0.5] as SnapshotPoint),
    hasPressure: true,
    timestamp: 0,
  };
}

function snapshot(strokes = [stroke('a'), stroke('b')]): RecognitionSnapshot {
  return {
    sourcePath: 'Blackboard/clase.blackboard',
    sourceVersion: 1,
    fingerprint: 'fp-1',
    width: 800,
    height: 600,
    contentBounds: { x: 0, y: 0, width: 800, height: 600 },
    strokes,
  };
}

function region(id: string, strokeIds: string[], order = 1): RecognitionRegion {
  return {
    id,
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    strokeIds,
    kind: 'math',
    readingOrder: order,
  };
}

function engineWith(
  child: FakeChild,
  overrides: Partial<ConstructorParameters<typeof MathNoteEngine>[0]> = {},
) {
  const spawnSidecar = vi.fn(() => child) as unknown as SidecarSpawn;
  const engine = new MathNoteEngine({
    pythonPath: '/opt/venv/bin/python',
    spawnSidecar,
    timeoutMs: 200,
    workingDirectory: '/tmp',
    ...overrides,
  });
  return { engine, spawnSidecar };
}

function answer(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    ok: true,
    engine: MATHNOTE_ENGINE_ID,
    latex: '\\frac{2}{3} = x',
    confidence: 0.93,
    symbols: 4,
    unexplained: 0,
    grouping: null,
    durationMs: 12,
    ...overrides,
  };
}

describe('MathNoteEngine', () => {
  it('starts the sidecar from the embedded source, never from a file in the vault', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op === 'detect') self.reply(answer({ id: request.id }));
    });
    const { engine, spawnSidecar } = engineWith(child, { pythonPath: '/opt/venv/bin/python' });

    await engine.recognize(snapshot(), [region('region-001', ['a', 'b'])], new AbortController().signal);

    expect(spawnSidecar).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSidecar.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe('/opt/venv/bin/python');
    expect(args.slice(0, 2)).toEqual(['-u', '-c']);
    expect(args[2]).toContain('mathnote_ocr');
    // No path, no board content and no shell command enters the argument list.
    expect(args[2]).not.toContain('Blackboard');
    expect(options.cwd).toBe('/tmp');
    expect((options.env as Record<string, string>).PYTHONDONTWRITEBYTECODE).toBe('1');
  });

  it('sends one request per region and keeps LaTeX above the confidence gate', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op === 'detect') self.reply(answer({ id: request.id, latex: `x_{${request.id}}` }));
    });
    const { engine } = engineWith(child);

    const doc = await engine.recognize(
      snapshot([stroke('a'), stroke('b'), stroke('c')]),
      [region('region-001', ['a']), region('region-002', ['b', 'c'], 2)],
      new AbortController().signal,
    );

    const detect = child.requests.filter((entry) => entry.op === 'detect');
    expect(detect).toHaveLength(2);
    expect(detect[0].id).toBe('region-001');
    expect(detect[1].id).toBe('region-002');
    expect(detect[0].protocol).toBe(1);
    expect(detect[1].strokes).toEqual([
      [
        [0, 0],
        [10, 10],
      ],
      [
        [0, 0],
        [10, 10],
      ],
    ]);

    expect(doc.simulated).toBe(false);
    expect(doc.engineId).toBe(MATHNOTE_ENGINE_ID);
    expect(doc.regions).toEqual([
      { regionId: 'region-001', content: { kind: 'math', latex: 'x_{region-001}', confidence: 0.93 } },
      { regionId: 'region-002', content: { kind: 'math', latex: 'x_{region-002}', confidence: 0.93 } },
    ]);
  });

  it('matches answers by id, so a stray answer cannot land on another region', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op !== 'detect') return;
      // An answer for an unknown id must be ignored; only the matching id resolves the wait.
      self.reply(answer({ id: 'region-999', latex: 'stray' }));
      self.reply(answer({ id: request.id, latex: `latex-${request.id}` }));
    });
    const { engine } = engineWith(child);

    const doc = await engine.recognize(
      snapshot(),
      [region('region-001', ['a']), region('region-002', ['b'], 2)],
      new AbortController().signal,
    );

    expect(doc.regions.map((entry) => entry.content.latex)).toEqual([
      'latex-region-001',
      'latex-region-002',
    ]);
  });

  it('drops a region whose confidence is below the gate and keeps it pending', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op === 'detect') self.reply(answer({ id: request.id, confidence: 0.41 }));
    });
    const { engine } = engineWith(child);

    const doc = await engine.recognize(snapshot(), [region('region-001', ['a'])], new AbortController().signal);

    expect(doc.regions[0].content).toEqual({ kind: 'unknown' });
    expect(doc.warnings.join('\n')).toContain('resultado descartado');
  });

  it('drops a region that leaves too many strokes unexplained, even at confidence 1.0', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op === 'detect') self.reply(answer({ id: request.id, confidence: 1, unexplained: 2 }));
    });
    const { engine } = engineWith(child);

    const doc = await engine.recognize(
      snapshot(),
      [region('region-001', ['a', 'b'])],
      new AbortController().signal,
    );

    expect(doc.regions[0].content).toEqual({ kind: 'unknown' });
    expect(doc.warnings.join('\n')).toContain('2/2 trazos sin explicar');
  });

  it('keeps a region with a small number of unexplained strokes', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op === 'detect') self.reply(answer({ id: request.id, unexplained: 1 }));
    });
    const { engine } = engineWith(child);
    const strokes = Array.from({ length: 8 }, (_, index) => stroke(`s${index}`));

    const doc = await engine.recognize(
      snapshot(strokes),
      [region('region-001', strokes.map((entry) => entry.id))],
      new AbortController().signal,
    );

    expect(doc.regions[0].content.kind).toBe('math');
    expect(doc.warnings.join('\n')).toContain('1 de 8 trazos');
  });

  it('reports an engine error without inventing content', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op === 'detect') self.reply({ protocol: 1, id: request.id, ok: false, error: 'boom' });
    });
    const { engine } = engineWith(child);

    const doc = await engine.recognize(snapshot(), [region('region-001', ['a'])], new AbortController().signal);

    expect(doc.regions[0].content).toEqual({ kind: 'unknown' });
    expect(doc.warnings.join('\n')).toContain('boom');
  });

  it('never sends an empty region to the engine', async () => {
    const child = new FakeChild();
    const { engine } = engineWith(child);

    const doc = await engine.recognize(snapshot(), [region('region-001', [])], new AbortController().signal);

    expect(child.requests).toHaveLength(0);
    expect(doc.regions[0].content).toEqual({ kind: 'unknown' });
    expect(doc.warnings.join('\n')).toContain('región vacía');
  });

  it('times out, kills the process and leaves the region pending', async () => {
    const child = new FakeChild(); // never answers
    const { engine } = engineWith(child, { timeoutMs: 20 });

    const doc = await engine.recognize(snapshot(), [region('region-001', ['a'])], new AbortController().signal);

    expect(doc.regions[0].content).toEqual({ kind: 'unknown' });
    expect(doc.warnings.join('\n')).toContain('sin respuesta en 20 ms');
    expect(child.killed).toBe(true);
  });

  it('reports a crashed process and still resolves the conversion', async () => {
    const child = new FakeChild((_request, self) => {
      queueMicrotask(() => self.crash(2, 'ImportError: no mathnote_ocr\n'));
    });
    const { engine } = engineWith(child);

    const doc = await engine.recognize(snapshot(), [region('region-001', ['a'])], new AbortController().signal);

    expect(doc.regions[0].content).toEqual({ kind: 'unknown' });
    expect(doc.warnings.join('\n')).toContain('código 2');
    expect(doc.warnings.join('\n')).toContain('ImportError');
    expect(child.killed).toBe(true);
  });

  it('rejects with AbortError on cancellation and kills the process', async () => {
    const child = new FakeChild(); // never answers
    const { engine } = engineWith(child);
    const controller = new AbortController();

    const running = engine.recognize(
      snapshot(),
      [region('region-001', ['a'])],
      controller.signal,
    );
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.killed).toBe(true);
  });

  it('refuses an already-cancelled conversion without spawning anything', async () => {
    const child = new FakeChild();
    const { engine, spawnSidecar } = engineWith(child);
    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.recognize(snapshot(), [region('region-001', ['a'])], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawnSidecar).not.toHaveBeenCalled();
  });

  it('closes the pipes and kills the child after a successful conversion', async () => {
    const child = new FakeChild((request, self) => {
      if (request.op === 'detect') self.reply(answer({ id: request.id }));
    });
    const { engine } = engineWith(child);

    await engine.recognize(snapshot(), [region('region-001', ['a'])], new AbortController().signal);

    expect(child.stdinEnded).toBe(true);
    expect(child.killed).toBe(true);
  });

  it('returns an empty document without starting a process when there are no regions', async () => {
    const child = new FakeChild();
    const { engine, spawnSidecar } = engineWith(child);

    const doc = await engine.recognize(snapshot(), [], new AbortController().signal);
    expect(doc.regions).toEqual([]);
    expect(spawnSidecar).not.toHaveBeenCalled();
  });
});
