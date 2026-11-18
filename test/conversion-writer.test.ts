import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { ObsidianConversionWriter } from '../src/infrastructure/recognition/obsidian-output-writer';

function fakeApp(existing: string[] = [], initialContent: Record<string, string> = {}) {
  const paths = new Set(existing);
  const files = new Map<string, any>();
  for (const path of existing) {
    if (path.endsWith('.md')) {
      files.set(path, Object.assign(new TFile(), { path, extension: 'md', basename: path.split('/').pop()!.replace(/\.md$/, '') }));
    } else {
      files.set(path, { path });
    }
  }
  const contents = new Map(Object.entries(initialContent));
  const writes: Array<{ type: string; path: string; data?: unknown }> = [];
  const vault = {
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    createFolder: vi.fn(async (path: string) => { paths.add(path); files.set(path, { path }); writes.push({ type: 'folder', path }); }),
    create: vi.fn(async (path: string, data: string) => {
      paths.add(path);
      const file = Object.assign(new TFile(), { path, extension: path.endsWith('.md') ? 'md' : '', basename: path.split('/').pop() ?? '' });
      files.set(path, file);
      contents.set(path, data);
      writes.push({ type: 'text', path, data });
      return file;
    }),
    createBinary: vi.fn(async (path: string, data: ArrayBuffer) => { paths.add(path); writes.push({ type: 'binary', path, data }); return { path }; }),
    process: vi.fn(async (file: TFile, update: (value: string) => string) => {
      const data = update(contents.get(file.path) ?? '');
      contents.set(file.path, data);
      writes.push({ type: 'process', path: file.path, data });
      return data;
    }),
  };
  return {
    app: { vault, workspace: { activeEditor: null, iterateAllLeaves: vi.fn() } } as any,
    vault,
    writes,
    contents,
    files,
  };
}

describe('ObsidianConversionWriter', () => {
  it('chooses a new name instead of overwriting an existing conversion', () => {
    const { app } = fakeApp([
      'Blackboard/Clase - convertido.md',
      'Blackboard/Clase - convertido 2-assets',
    ]);
    const writer = new ObsidianConversionWriter(app);
    expect(writer.plan('Blackboard/Clase.blackboard')).toEqual({
      notePath: 'Blackboard/Clase - convertido 3.md',
      assetFolder: 'Blackboard/Clase - convertido 3-assets',
    });
  });

  it('writes resources before the Markdown note', async () => {
    const { app, writes } = fakeApp();
    const writer = new ObsidianConversionWriter(app);
    const destination = writer.plan('Blackboard/Clase.blackboard');
    await writer.write(destination, '# Preview', [
      { key: 'r', fileName: 'region.svg', mimeType: 'image/svg+xml', data: '<svg />' },
      { key: 'p', fileName: 'reference.png', mimeType: 'image/png', data: new Uint8Array([1]).buffer },
    ]);
    expect(writes.map((write) => write.type)).toEqual(['folder', 'text', 'binary', 'text']);
    expect(writes.at(-1)?.path).toBe(destination.notePath);
  });

  it('refuses to write if the planned destination appeared before saving', async () => {
    const { app, vault } = fakeApp();
    const writer = new ObsidianConversionWriter(app);
    const destination = writer.plan('Blackboard/Clase.blackboard');
    vault.getAbstractFileByPath.mockImplementation((path: string) => path === destination.notePath ? { path } : null);
    await expect(writer.write(destination, '# no', [])).rejects.toThrow('ya existe');
    expect(vault.createFolder).not.toHaveBeenCalled();
  });

  it('does not create an asset folder for a text-only note', async () => {
    const { app, writes, vault } = fakeApp();
    const writer = new ObsidianConversionWriter(app);
    const destination = writer.plan('Blackboard/Clase.blackboard');
    await writer.write(destination, '# Solo texto', []);
    expect(vault.createFolder).not.toHaveBeenCalled();
    expect(writes.map((write) => write.type)).toEqual(['text']);
    expect(writes[0].path).toBe(destination.notePath);
  });

  it('appends to the latest note content and rejects the same snapshot twice', async () => {
    const notePath = 'Clases/Álgebra.md';
    const { app, vault, contents } = fakeApp([notePath], { [notePath]: '# Clase\n\nContenido concurrente' });
    const writer = new ObsidianConversionWriter(app);
    const destination = {
      ...writer.planInsertion(notePath, 'Blackboard/Ecuación.blackboard'),
      idempotencyKey: 'fingerprint-1',
    };

    await writer.write(destination, '$$x^2$$', []);

    expect(vault.process).toHaveBeenCalledOnce();
    expect(contents.get(notePath)).toContain('Contenido concurrente\n\n$$x^2$$');
    expect(contents.get(notePath)).toContain('<!-- caelestia-ocr:fingerprint-1 -->');
    await expect(writer.write(destination, '$$x^2$$', [])).rejects.toThrow('ya fue insertado');
  });

  it('uses the active target editor so insertion is undoable', async () => {
    const notePath = 'Clases/Cálculo.md';
    const { app, vault, files } = fakeApp([notePath], { [notePath]: '# En disco' });
    const replaceRange = vi.fn();
    app.workspace.activeEditor = {
      file: files.get(notePath),
      editor: { getValue: () => '# Cambio todavía en el editor', replaceRange },
    };
    const writer = new ObsidianConversionWriter(app);
    const destination = writer.planInsertion(notePath, 'Blackboard/Integral.blackboard');

    await writer.write(destination, '$$\\int x\,dx$$', []);

    expect(replaceRange).toHaveBeenCalledWith(
      expect.stringContaining('$$\\int x\,dx$$'),
      { line: 0, ch: '# Cambio todavía en el editor'.length },
    );
    expect(vault.process).not.toHaveBeenCalled();
  });

  it('inserts into the original tab after the user activates a different note', async () => {
    const targetPath = 'Clases/Objetivo.md';
    const otherPath = 'Clases/Otra.md';
    const { app, vault, files } = fakeApp([targetPath, otherPath]);
    const targetReplace = vi.fn();
    const targetEditor = { getValue: () => '# Objetivo', replaceRange: targetReplace };
    app.workspace.activeEditor = {
      file: files.get(otherPath),
      editor: { getValue: () => '# Otra', replaceRange: vi.fn() },
    };
    app.workspace.iterateAllLeaves = (callback: (leaf: any) => void) => {
      callback({ view: { file: files.get(otherPath), editor: app.workspace.activeEditor.editor } });
      callback({ view: { file: files.get(targetPath), editor: targetEditor } });
    };
    const writer = new ObsidianConversionWriter(app);

    await writer.write(
      writer.planInsertion(targetPath, 'Blackboard/Objetivo.blackboard'),
      'Reconocido',
      [],
    );

    expect(targetReplace).toHaveBeenCalledWith(expect.stringContaining('Reconocido'), { line: 0, ch: 10 });
    expect(app.workspace.activeEditor.editor.replaceRange).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
  });

  it('stops if the original destination note no longer exists', async () => {
    const { app } = fakeApp();
    const writer = new ObsidianConversionWriter(app);
    await expect(writer.write({
      notePath: 'Movida.md',
      assetFolder: 'Movida-assets',
      mode: 'append',
    }, 'texto', [])).rejects.toThrow('ya no existe');
  });
});
