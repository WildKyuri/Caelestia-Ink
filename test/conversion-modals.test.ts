import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MarkdownPreviewModal } from '../src/presentation/conversion-modals';
import type {
  ConversionDestination,
  ConversionDraft,
  ConversionDiagnostics,
  OutputAsset,
  RecognitionRegion,
  RecognitionSnapshot,
  RegionAssetExporter,
} from '../src/domain/recognition';
import type { ObsidianConversionWriter } from '../src/infrastructure/recognition/obsidian-output-writer';

const destination: ConversionDestination = {
  notePath: 'Blackboard/clase - convertido.md',
  assetFolder: 'Blackboard/clase - convertido-assets',
};

function region(id: string, order: number, kind: RecognitionRegion['kind']): RecognitionRegion {
  return {
    id,
    bounds: { x: order * 100, y: 0, width: 80, height: 40 },
    strokeIds: [`${id}-stroke`],
    kind,
    readingOrder: order,
  };
}

function draft(): ConversionDraft {
  const regions = [region('region-001', 1, 'math'), region('region-002', 2, 'graphic')];
  const diagnostics: ConversionDiagnostics = {
    engineId: 'test-engine',
    simulated: false,
    fingerprint: 'abc123',
    durationMs: 12,
    strokeCount: regions.length,
    regionCount: regions.length,
    regions: regions.map((entry) => ({
      regionId: entry.id,
      readingOrder: entry.readingOrder,
      strokeCount: entry.strokeIds.length,
      bounds: entry.bounds,
      kind: entry.kind,
      engineKind: entry.kind,
      engineId: 'test-engine',
      simulated: false,
    })),
    warnings: ['aviso de prueba'],
  };
  return {
    destination,
    snapshot: { sourcePath: 'Blackboard/clase.blackboard' } as RecognitionSnapshot,
    document: {
      sourcePath: 'Blackboard/clase.blackboard',
      sourceFingerprint: 'abc123',
      engineId: 'test-engine',
      simulated: false,
      regions: [
        {
          regionId: 'region-001',
          content: {
            kind: 'math',
            latex: '\\frac{2}{3} = x - y = f',
            confidence: 0.9,
          },
        },
        { regionId: 'region-002', content: { kind: 'graphic', caption: 'Diagrama' } },
      ],
      warnings: [],
    },
    regions,
    markdown: '$$\n\\frac{2}{3} = x - y = f\n$$',
    assets: [],
    diagnostics,
  };
}

function exporter(): RegionAssetExporter & { export: ReturnType<typeof vi.fn> } {
  const exported = vi.fn(() => '<svg></svg>');
  return { export: exported } as unknown as RegionAssetExporter & { export: ReturnType<typeof vi.fn> };
}

function writer(): ObsidianConversionWriter & { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(async () => undefined) } as unknown as ObsidianConversionWriter & {
    write: ReturnType<typeof vi.fn>;
  };
}

function openPreview() {
  const assets = exporter();
  const sink = writer();
  const modal = new MarkdownPreviewModal({} as never, draft(), assets, sink);
  modal.open();
  return { modal, assets, sink };
}

describe('conversion preview modal layout', () => {
  it('applies the dialog width to the modal box, never to its content', () => {
    const { modal } = openPreview();

    expect(modal.modalEl.classList.contains('blackboard-conversion-modal')).toBe(true);
    // Width on `.modal-content` overflowed the dialog it lives in.
    expect(modal.contentEl.classList.contains('blackboard-conversion-modal')).toBe(false);
    expect(modal.contentEl.classList.contains('blackboard-conversion-body')).toBe(true);
  });

  it('keeps one visible classification selector per region', () => {
    const { modal } = openPreview();
    const selects = Array.from(modal.contentEl.querySelectorAll('select'));

    expect(selects).toHaveLength(2);
    expect(selects.map((select) => select.value)).toEqual(['math', 'graphic']);
    expect(selects[0].closest('.blackboard-conversion-hidden')).toBeNull();
  });

  it('regenerates Markdown and assets when a region is reclassified', () => {
    const { modal, assets } = openPreview();
    const textarea = modal.contentEl.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('$$');

    const firstSelect = modal.contentEl.querySelector('select') as HTMLSelectElement;
    firstSelect.value = 'graphic';
    firstSelect.dispatchEvent(new Event('change'));

    expect(textarea.value).toContain('region-001.svg');
    expect(textarea.value).not.toContain('\\frac{2}{3}');

    // The graphic region always kept its asset; the corrected one now has one too.
    const names = assets.export.mock.calls.length;
    expect(names).toBeGreaterThanOrEqual(1);
    expect(textarea.value).toContain('![[Blackboard/clase - convertido-assets/region-001.svg');
  });

  it('lets the user correct a math transcription and regenerates the block', () => {
    const { modal } = openPreview();
    const input = modal.contentEl.querySelector('.blackboard-conversion-latex-input') as HTMLInputElement;
    const textarea = modal.contentEl.querySelector('textarea') as HTMLTextAreaElement;

    expect(input.disabled).toBe(false);
    expect(input.value).toContain('\\frac{2}{3}');

    input.value = '\\frac{2}{3} = x - y';
    input.dispatchEvent(new Event('input'));

    expect(textarea.value).toContain('$$');
    expect(textarea.value).toContain('\\frac{2}{3} = x - y');
    // The engine's extra symbols are gone: the user's reading replaced it for this region.
    expect(textarea.value).not.toContain('= f');
  });

  it('only enables LaTeX editing once a region is classified as math', () => {
    const { modal } = openPreview();
    const inputs = Array.from(
      modal.contentEl.querySelectorAll('.blackboard-conversion-latex-input'),
    ) as HTMLInputElement[];
    const selects = Array.from(modal.contentEl.querySelectorAll('select')) as HTMLSelectElement[];

    expect(inputs[1].disabled).toBe(true); // graphic region

    selects[1].value = 'math';
    selects[1].dispatchEvent(new Event('change'));

    expect(inputs[1].disabled).toBe(false);
  });

  it('keeps diagnostics collapsed in a disclosure element', () => {
    const { modal } = openPreview();
    const details = modal.contentEl.querySelector('details.blackboard-conversion-diagnostics');

    expect(details).not.toBeNull();
    expect(details?.querySelector('summary')?.textContent).toContain('Diagnóstico');
    // Nothing about the engine's run is printed in the note body itself.
    const textarea = modal.contentEl.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).not.toContain('aviso de prueba');
    expect(textarea.value).not.toContain('confianza');
    expect(textarea.value).not.toContain('12 ms');
  });

  it('renders the preview through the Markdown renderer, LaTeX included', () => {
    const { modal } = openPreview();
    const rendered = modal.contentEl.querySelector('.blackboard-conversion-preview-rendered');

    expect(rendered?.textContent).toContain('\\frac{2}{3} = x - y = f');
  });
});

describe('conversion modal stylesheet guarantees', () => {
  const css = readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');

  it('never gives the dialog content a fixed viewport width', () => {
    expect(css).not.toMatch(/\.blackboard-conversion-modal\s*\{[^}]*width:\s*min\(880px,\s*92vw\)/);
    expect(css).toMatch(/\.modal\.blackboard-conversion-modal\s*\{[^}]*max-width:\s*calc\(100vw - 32px\)/);
    expect(css).toMatch(/\.blackboard-conversion-modal \.modal-content\s*\{[^}]*min-width:\s*0/);
  });

  it('scrolls wide math inside the preview instead of the dialog', () => {
    const block = css.match(/\.blackboard-conversion-preview-rendered\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).toContain('overflow: auto');
    expect(block).toContain('max-width: 100%');
    expect(css).toMatch(/\.blackboard-conversion-preview-rendered mjx-container[^{]*\{[^}]*overflow-x:\s*auto/);
  });

  it('lets region rows wrap so the selectors stay reachable on narrow windows', () => {
    const block = css.match(/\.blackboard-conversion-region\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).toContain('flex-wrap: wrap');
    expect(block).toContain('min-width: 0');
  });
});
