import { App, Component, FuzzySuggestModal, MarkdownRenderer, Modal, Notice, TFile } from 'obsidian';
import type {
  ConversionDraft,
  ConversionProgress,
  OutputAsset,
  RegionKind,
} from '../domain/recognition';
import type { DrawingSurface } from './drawing-surface';
import type { SurfaceManager } from './surface-manager';
import type { ConvertBlackboardUseCase } from '../application/recognition/convert-blackboard';
import type { ObsidianConversionWriter } from '../infrastructure/recognition/obsidian-output-writer';
import type { RegionAssetExporter } from '../domain/recognition';
import { initialClassification, renderConversion } from '../application/recognition/render-conversion';
import { isGraphicKind, sortedRegions } from '../application/recognition/assets';

const KIND_OPTIONS: ReadonlyArray<{ value: RegionKind; label: string }> = [
  { value: 'text', label: 'Texto' },
  { value: 'math', label: 'Matemáticas' },
  { value: 'table', label: 'Tabla' },
  { value: 'graphic', label: 'Gráfico' },
  { value: 'unknown', label: 'Pendiente' },
];

class ConversionProgressModal extends Modal {
  private statusEl!: HTMLElement;
  private progressEl!: HTMLProgressElement;
  private completed = false;

  constructor(app: App, private controller: AbortController) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    // The width belongs to Obsidian's `.modal` box; setting it on `.modal-content`
    // made the content wider than its parent and produced horizontal overflow.
    if (this.modalEl) this.modalEl.addClass('blackboard-conversion-modal');
    this.contentEl.addClass('blackboard-conversion-body');
    this.contentEl.createEl('h2', { text: 'Caelestia-Ink: Convertir a nota' });
    this.statusEl = this.contentEl.createDiv({ cls: 'blackboard-conversion-status', text: 'Preparando conversión…' });
    this.progressEl = this.contentEl.createEl('progress');
    this.progressEl.max = 4;
    this.progressEl.value = 0;
    const actions = this.contentEl.createDiv({ cls: 'blackboard-conversion-actions' });
    const cancel = actions.createEl('button', { text: 'Cancelar' });
    cancel.addEventListener('click', () => {
      this.controller.abort();
      this.close();
    });
  }

  update(progress: ConversionProgress): void {
    if (!this.statusEl || !this.progressEl) return;
    this.statusEl.textContent = progress.message;
    this.progressEl.max = progress.total;
    this.progressEl.value = progress.completed;
  }

  finish(): void {
    this.completed = true;
    this.close();
  }

  onClose(): void {
    if (!this.completed) this.controller.abort();
    this.contentEl.empty();
  }
}

export class MarkdownPreviewModal extends Modal {
  private kinds: Map<string, RegionKind>;
  // Corrections typed in the preview. Only math regions read them, and they replace the
  // engine's LaTeX for that region in the generated note.
  private latexOverrides = new Map<string, string>();
  private assets: OutputAsset[] = [];
  private readonly component = new Component();
  private previewEl!: HTMLElement;
  private sourceEl!: HTMLTextAreaElement;
  private diagnosticsEl!: HTMLElement;
  private sourceVisible = false;

  constructor(
    app: App,
    private draft: ConversionDraft,
    private exporter: RegionAssetExporter,
    private writer: ObsidianConversionWriter,
  ) {
    super(app);
    this.kinds = initialClassification(draft.document);
  }

  onOpen(): void {
    this.contentEl.empty();
    // The width belongs to Obsidian's `.modal` box; setting it on `.modal-content`
    // made the content wider than its parent and produced horizontal overflow.
    if (this.modalEl) this.modalEl.addClass('blackboard-conversion-modal');
    this.contentEl.addClass('blackboard-conversion-body');
    this.component.load();
    this.contentEl.createEl('h2', { text: 'Convertir a nota' });
    this.contentEl.createEl('p', {
      cls: 'blackboard-conversion-destination',
      text: `Destino: ${this.draft.destination.notePath}`,
    });
    if (this.draft.document.simulated) {
      this.contentEl.createDiv({
        cls: 'blackboard-conversion-warning',
        text: `Motor de desarrollo (${this.draft.document.engineId}): contenido de muestra, sin reconocimiento manuscrito.`,
      });
    }
    this.buildRegionList();
    this.buildPreview();
    this.buildDiagnostics();
    this.buildActions();
    this.rebuild();
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }

  private buildRegionList(): void {
    const section = this.contentEl.createDiv({ cls: 'blackboard-conversion-section' });
    section.createEl('h3', { text: 'Regiones' });
    section.createEl('p', {
      cls: 'blackboard-conversion-hint',
      text: 'Cambia la clasificación si el motor se equivocó y corrige el LaTeX de cada ecuación. El Markdown se regenera al instante.',
    });
    const list = section.createDiv({ cls: 'blackboard-conversion-regions' });
    for (const region of sortedRegions(this.draft.regions)) {
      const row = list.createDiv({ cls: 'blackboard-conversion-region' });
      row.createSpan({
        cls: 'blackboard-conversion-region-name',
        text: `${region.id} · ${region.strokeIds.length} ${region.strokeIds.length === 1 ? 'trazo' : 'trazos'}`,
      });
      const select = row.createEl('select');
      for (const option of KIND_OPTIONS) {
        select.createEl('option', { value: option.value, text: option.label });
      }
      select.value = this.kinds.get(region.id) ?? 'unknown';

      // Editable transcription: the engine's reading is a starting point, not a verdict.
      // Typing here only changes this region's math block; it never touches the strokes.
      const latexRow = list.createDiv({ cls: 'blackboard-conversion-latex' });
      const engineLatex = this.draft.document.regions
        .find((entry) => entry.regionId === region.id)?.content.latex ?? '';
      const input = latexRow.createEl('input', {
        type: 'text',
        cls: 'blackboard-conversion-latex-input',
        placeholder: 'LaTeX de esta región',
      });
      input.value = this.latexOverrides.get(region.id) ?? engineLatex;
      input.disabled = select.value !== 'math';
      input.addEventListener('input', () => {
        this.latexOverrides.set(region.id, input.value);
        this.rebuild();
      });

      select.addEventListener('change', () => {
        this.kinds.set(region.id, select.value as RegionKind);
        input.disabled = select.value !== 'math';
        this.rebuild();
        new Notice('Vista previa regenerada con la nueva clasificación.');
      });
    }
    if (this.draft.regions.length === 0) {
      section.createEl('p', { cls: 'blackboard-conversion-hint', text: 'La pizarra no tiene trazos.' });
    }
  }

  private buildPreview(): void {
    const section = this.contentEl.createDiv({ cls: 'blackboard-conversion-section' });
    const header = section.createDiv({ cls: 'blackboard-conversion-preview-header' });
    header.createEl('h3', { text: 'Vista previa' });
    const toggle = header.createEl('button', { text: 'Editar Markdown' });
    toggle.addEventListener('click', () => {
      this.sourceVisible = !this.sourceVisible;
      this.sourceEl.toggleClass('blackboard-conversion-hidden', !this.sourceVisible);
      toggle.textContent = this.sourceVisible ? 'Ocultar Markdown' : 'Editar Markdown';
      if (this.sourceVisible) this.sourceEl.focus();
    });
    this.previewEl = section.createDiv({ cls: 'blackboard-conversion-preview-rendered markdown-rendered' });
    this.sourceEl = section.createEl('textarea', {
      cls: 'blackboard-conversion-preview blackboard-conversion-hidden',
    });
    this.sourceEl.addEventListener('input', () => {
      this.markdownSourceChanged();
    });
  }

  private buildDiagnostics(): void {
    const details = this.contentEl.createEl('details', { cls: 'blackboard-conversion-diagnostics' });
    details.createEl('summary', { text: 'Diagnóstico (no se guarda en la nota)' });
    this.diagnosticsEl = details.createDiv();
  }

  private buildActions(): void {
    const actions = this.contentEl.createDiv({ cls: 'blackboard-conversion-actions' });
    const cancel = actions.createEl('button', { text: 'Cancelar' });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', {
      text: this.draft.destination.mode === 'append' ? 'Insertar en nota' : 'Guardar nota',
    });
    save.addClass('mod-cta');
    save.addEventListener('click', () => { void (async () => {
      save.disabled = true;
      try {
        await this.writer.write(this.draft.destination, this.sourceEl.value, this.assets);
        new Notice(
          this.draft.destination.mode === 'append'
            ? `Contenido insertado en: ${this.draft.destination.notePath}`
            : `Nota creada: ${this.draft.destination.notePath}`,
        );
        const file = this.app.vault.getAbstractFileByPath(this.draft.destination.notePath);
        this.close();
        if (this.draft.destination.mode !== 'append' && file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      } catch (error) {
        save.disabled = false;
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`No se pudo guardar la conversión: ${message}`, 8000);
      }
    })(); });
  }

  private markdownSourceChanged(): void {
    // Manual edits do not change the region map, so the asset list stays as generated.
    this.previewEl.empty();
    void MarkdownRenderer.render(
      this.app,
      this.sourceEl.value,
      this.previewEl,
      this.draft.destination.notePath,
      this.component,
    );
  }

  private rebuild(): void {
    const rendered = renderConversion(this.draft, this.kinds, this.exporter, this.latexOverrides);
    this.assets = [...rendered.assets];
    this.sourceEl.value = rendered.markdown;
    this.previewEl.empty();
    void MarkdownRenderer.render(
      this.app,
      rendered.markdown,
      this.previewEl,
      this.draft.destination.notePath,
      this.component,
    );
    this.renderDiagnostics();
  }

  private renderDiagnostics(): void {
    this.diagnosticsEl.empty();
    const list = this.diagnosticsEl.createEl('dl');
    const pair = (term: string, value: string) => {
      list.createEl('dt', { text: term });
      list.createEl('dd', { text: value });
    };
    pair('Motor', `${this.draft.diagnostics.engineId}${this.draft.diagnostics.simulated ? ' (simulado)' : ''}`);
    pair('Huella', this.draft.diagnostics.fingerprint);
    pair('Trazos', String(this.draft.diagnostics.strokeCount));
    pair('Regiones', String(this.draft.diagnostics.regionCount));
    pair('Duración', `${this.draft.diagnostics.durationMs} ms`);
    const regions = this.diagnosticsEl.createDiv({ cls: 'blackboard-conversion-diagnostic-regions' });
    for (const region of this.draft.diagnostics.regions) {
      const kind = this.kinds.get(region.regionId) ?? region.kind;
      const parts = [
        region.regionId,
        kind,
        `${region.strokeCount} trazos`,
        `sugerida: ${region.engineKind}`,
      ];
      if (typeof region.confidence === 'number') parts.push(`confianza ${region.confidence.toFixed(2)}`);
      if (isGraphicKind(kind)) parts.push('exporta SVG');
      regions.createDiv({ text: parts.join(' · ') });
    }
    for (const warning of this.draft.diagnostics.warnings) {
      regions.createDiv({ cls: 'blackboard-conversion-diagnostic-warning', text: warning });
    }
  }
}

export class MarkdownDestinationModal extends FuzzySuggestModal<TFile> {
  private settled = false;

  constructor(app: App, private resolveSelection: (path: string | null) => void) {
    super(app);
    this.setPlaceholder('Selecciona explícitamente la nota Markdown destino');
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.settle(file.path);
  }

  onClose(): void {
    // SuggestModal closes before FuzzySuggestModal dispatches onChooseItem. Resolving null
    // synchronously here wins that race and discards the file the user just chose. Defer the
    // cancellation one microtask so onChooseItem can preserve the explicit path first.
    queueMicrotask(() => this.settle(null));
  }

  private settle(path: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveSelection(path);
  }
}

function chooseMarkdownDestination(app: App): Promise<string | null> {
  return new Promise((resolve) => new MarkdownDestinationModal(app, resolve).open());
}

export class ConversionController {
  private active: AbortController | null = null;

  constructor(
    private app: App,
    private surfaces: SurfaceManager,
    private useCase: ConvertBlackboardUseCase | null,
    private writer: ObsidianConversionWriter,
    private exporter: RegionAssetExporter,
    private loadUseCase?: () => Promise<ConvertBlackboardUseCase | null>,
  ) {}

  /** Document of the focused window, so a popout converts its own drawing. */
  private activeDocument(): Document {
    if (typeof activeWindow !== 'undefined' && activeWindow?.document) return activeWindow.document;
    return this.app.workspace.containerEl.ownerDocument;
  }

  async start(surface?: DrawingSurface): Promise<void> {
    if (this.active) {
      new Notice('Ya hay una conversión en curso.');
      return;
    }
    const controller = new AbortController();
    this.active = controller;
    let progress: ConversionProgressModal | null = null;
    try {
      // Convert only the drawing the request came from (the toolbar's bound surface), never a
      // drawing left open behind a note or in another pane.
      const target = surface
        ? this.surfaces.conversionTargetForSurface(surface)
        : this.surfaces.conversionTargetForDocument(this.activeDocument());
      const sourcePath = target?.getSourcePath() ?? '';
      if (!target || !sourcePath) {
        new Notice('Activa una pizarra Blackboard antes de convertir.');
        return;
      }
      const suggestedDestination = target.getDestinationNotePath?.() ?? null;
      const notePath = suggestedDestination ?? await chooseMarkdownDestination(this.app);
      if (!notePath) {
        new Notice('Conversión cancelada: no se seleccionó una nota Markdown destino.');
        return;
      }
      const useCase = this.useCase ?? (this.loadUseCase ? await this.loadUseCase() : null);
      if (!useCase) {
        new Notice('No hay un motor local configurado. Revisa Ajustes → Blackboard → Recognition.');
        return;
      }
      const destination = this.writer.planInsertion(notePath, sourcePath);
      const progressModal = new ConversionProgressModal(this.app, controller);
      progress = progressModal;
      progressModal.open();
      const draft = await useCase.execute(target, destination, controller.signal, (value) => progressModal.update(value));
      progressModal.finish();
      new MarkdownPreviewModal(this.app, draft, this.exporter, this.writer).open();
    } catch (error) {
      progress?.finish();
      if (error instanceof DOMException && error.name === 'AbortError') {
        new Notice('Conversión cancelada.');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`No se pudo convertir la pizarra: ${message}`, 8000);
      }
    } finally {
      this.active = null;
    }
  }
}
