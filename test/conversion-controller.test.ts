import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { ConversionController, MarkdownDestinationModal } from '../src/presentation/conversion-modals';
import type { ConversionTarget } from '../src/domain/recognition';

function target(notePath = 'Clases/Correcta.md'): ConversionTarget {
  return {
    getSourcePath: () => 'Blackboard/Ecuación.blackboard',
    getFile: () => ({
      version: 3,
      width: 100,
      height: 100,
      strokes: [],
      background: { color: 'transparent' },
    }),
    getDestinationNotePath: () => notePath,
  };
}

function app(): any {
  return {
    vault: {},
    workspace: { containerEl: document.createElement('div') },
  };
}

describe('ConversionController routing', () => {
  it('keeps the selected path when Obsidian closes the chooser before onChooseItem', async () => {
    let selected: string | null | undefined;
    const modal = new MarkdownDestinationModal(app(), (path) => { selected = path; });
    const file = Object.assign(new TFile(), { path: 'Clases/Destino explícito.md', extension: 'md' });

    modal.onClose();
    modal.onChooseItem(file);
    await Promise.resolve();

    expect(selected).toBe('Clases/Destino explícito.md');
  });

  it('resolves null once when the destination chooser is actually cancelled', async () => {
    const resolve = vi.fn();
    const modal = new MarkdownDestinationModal(app(), resolve);

    modal.onClose();
    await Promise.resolve();
    modal.onClose();

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(null);
  });

  it('uses the exact surface and its owning note, never a global active target', async () => {
    const requestedSurface = {} as any;
    const requestedTarget = target();
    const otherTarget = target('Clases/Incorrecta.md');
    const surfaces = {
      conversionTargetForSurface: vi.fn((surface) => surface === requestedSurface ? requestedTarget : otherTarget),
      conversionTargetForDocument: vi.fn(() => otherTarget),
    } as any;
    const expectedDestination = {
      notePath: 'Clases/Correcta.md',
      assetFolder: 'Clases/assets',
      mode: 'append' as const,
    };
    const writer = {
      planInsertion: vi.fn(() => expectedDestination),
    } as any;
    const useCase = {
      execute: vi.fn(async () => { throw new Error('stop after routing'); }),
    } as any;
    const controller = new ConversionController(app(), surfaces, useCase, writer, {} as any);

    await controller.start(requestedSurface);

    expect(surfaces.conversionTargetForSurface).toHaveBeenCalledWith(requestedSurface);
    expect(surfaces.conversionTargetForDocument).not.toHaveBeenCalled();
    expect(writer.planInsertion).toHaveBeenCalledWith(
      'Clases/Correcta.md',
      'Blackboard/Ecuación.blackboard',
    );
    expect(useCase.execute.mock.calls[0][0]).toBe(requestedTarget);
    expect(useCase.execute.mock.calls[0][1]).toBe(expectedDestination);
  });

  it('locks immediately so repeated clicks cannot load two engines', async () => {
    const surface = {} as any;
    const surfaces = {
      conversionTargetForSurface: vi.fn(() => target()),
    } as any;
    let release!: (value: null) => void;
    const loader = vi.fn(() => new Promise<null>((resolve) => { release = resolve; }));
    const controller = new ConversionController(
      app(),
      surfaces,
      null,
      { planInsertion: vi.fn() } as any,
      {} as any,
      loader,
    );

    const first = controller.start(surface);
    await Promise.resolve();
    await controller.start(surface);

    expect(loader).toHaveBeenCalledOnce();
    release(null);
    await first;
  });
});
