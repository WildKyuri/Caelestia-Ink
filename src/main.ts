import { Plugin, Platform, TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { PluginSettings } from './domain/entities';
import { DEFAULT_PLUGIN_SETTINGS, DEFAULT_TOOL_STATE, validateSettings } from './domain/entities';
import type { IDrawingRepository } from './domain/ports';
import { ToolManager } from './domain/tool-manager';
import { ObsidianDrawingRepository } from './infrastructure/obsidian-drawing-repository';
import { CreateDrawingUseCase } from './application/use-cases/create-drawing';
import { ExportSvgUseCase } from './application/use-cases/export-svg';
import { BlackboardView, VIEW_TYPE, FILE_EXTENSION } from './presentation/blackboard-view';
import { insertDrawingAtCursor, insertExistingDrawing, patchCanvas } from './presentation/canvas-integration';
import { BlackboardSettingTab } from './presentation/settings';
import { mountBlackboardEmbed, releaseDetachedEmbeds, unmountAllEmbeds } from './presentation/embed';
import { SurfaceManager } from './presentation/surface-manager';
import { DocumentStore } from './application/document-store';
import { GlobalToolbar } from './presentation/global-toolbar';
import { parseEmbedSize, fitSavedEmbedSize } from './presentation/embed-size';
import { ConvertBlackboardUseCase } from './application/recognition/convert-blackboard';
import { SvgRegionExporter } from './infrastructure/recognition/region-svg-exporter';
import { ObsidianConversionWriter } from './infrastructure/recognition/obsidian-output-writer';
import { ConversionController } from './presentation/conversion-modals';

// Replaced by esbuild `define` (true in dev builds, false in production, where the
// branch and the src/dev module behind it are eliminated from the bundle).
declare const __DEV_BUILD__: boolean;

/**
 * Whether a view type should host the collapsed no-surface toolbar pill. Only Canvas
 * qualifies: on Canvas, inserting a drawing node is a core action, so a persistent pill is a
 * useful affordance. Markdown is left out on purpose: a plain note has nothing to draw on,
 * and drawing embeds inside notes do not activate the global Blackboard toolbar.
 */
export function isPillHostViewType(viewType: string | undefined): boolean {
  return viewType === 'canvas';
}

export default class BlackboardPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;
  private repo!: IDrawingRepository;
  private createDrawingUseCase!: CreateDrawingUseCase;
  private exportSvgUseCase!: ExportSvgUseCase;
  private conversionController!: ConversionController;
  surfaceManager: SurfaceManager = new SurfaceManager();
  // Single source of truth for `.blackboard` stroke data, keyed by path. Every surface of a
  // file shares one canonical document so edits propagate across panes/embeds/canvas nodes,
  // with a debounced single writer and an own-write/external-edit reconcile guard.
  documentStore: DocumentStore = new DocumentStore();
  // Exactly one ToolManager is the global source of truth for the active tool and every
  // tool's colour/size, shared across the standalone view and every embed/canvas node.
  // Seeded once from code defaults at startup. Mounting a surface never re-seeds it, so
  // opening another drawing can't reset the tool or colour you picked.
  toolManager: ToolManager = new ToolManager({ ...DEFAULT_TOOL_STATE });
  private toolbars = new Map<Window, GlobalToolbar>();

  async onload(): Promise<void> {
    await this.loadSettings();

    if (__DEV_BUILD__) {
      const { startDevBridge } = await import('./dev/dev-bridge');
      startDevBridge(this);
    }

    this.repo = new ObsidianDrawingRepository(this.app);
    this.createDrawingUseCase = new CreateDrawingUseCase(this.repo);
    this.exportSvgUseCase = new ExportSvgUseCase(this.repo);
    const regionExporter = new SvgRegionExporter();
    this.conversionController = new ConversionController(
      this.app,
      this.surfaceManager,
      null,
      new ObsidianConversionWriter(this.app),
      regionExporter,
      () => this.loadRecognitionUseCase(),
    );

    this.registerView(VIEW_TYPE, (leaf) => new BlackboardView(leaf, this.settings, this.surfaceManager, this.toolManager, this.documentStore, this.repo));

    // One floating toolbar per Obsidian window. A popout has its own document and viewport,
    // so sharing the main window's toolbar left the popout without controls and hid it when
    // the main window opened a note.
    this.app.workspace.onLayoutReady?.(() => {
      this.ensureToolbar(this.mainWindow());
      this.app.workspace.iterateAllLeaves((leaf) => {
        const win = leaf.view?.containerEl?.ownerDocument?.defaultView;
        if (win && win !== this.mainWindow()) this.ensureToolbar(win);
      });
      this.register(() => {
        for (const toolbar of this.toolbars.values()) toolbar.destroy();
        this.toolbars.clear();
      });
      this.routeToolbar();
    });
    this.registerEvent(this.app.workspace.on('window-open', (_win, win) => {
      this.ensureToolbar(win);
      this.routeToolbar();
    }));
    this.registerEvent(this.app.workspace.on('window-close', (_win, win) => {
      this.toolbars.get(win)?.destroy();
      this.toolbars.delete(win);
      this.routeToolbar();
    }));
    // Flush pending debounced saves before the app is suspended (iPad lock screen / tab
    // hidden). A frozen WebView never fires the save timer, so an unflushed stroke would be
    // lost on lock; flushing on hide writes the canonical document while JS is still running.
    this.registerDomEvent(activeDocument, 'visibilitychange', () => {
      if (activeDocument.hidden) this.documentStore.flushAll();
    });
    this.registerDomEvent(activeWindow, 'pagehide', () => this.documentStore.flushAll());

    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.routeToolbar(leaf)));
    // A note can replace the drawing inside the same leaf without changing the active leaf,
    // and a tab switch inside a tab group only repaints the layout. Both must re-route the
    // toolbar, otherwise it stays bound to the drawing that just left the screen.
    this.registerEvent(this.app.workspace.on('file-open', () => this.routeToolbar()));
    // Keep the toolbar clamped inside the active view when the layout changes
    // (sidebar toggled, pane resized, device rotated) and re-route what it drives.
    this.registerEvent(this.app.workspace.on('resize', () => this.repositionToolbars()));
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.routeToolbar();
      this.repositionToolbars();
    }));
    try {
      this.registerExtensions([FILE_EXTENSION], VIEW_TYPE);
    } catch {
      // Extension may still be registered from a previous load (e.g. plugin re-enable);
      // ignore so onload doesn't abort and leave the plugin disabled.
    }

    this.addCommand({
      id: 'new-drawing',
      name: 'New drawing',
      callback: async () => {
        try {
          const path = await this.createDrawingUseCase.execute(
            this.settings,
            this.settings.newFileLocation,
            this.app.workspace.getActiveFile()?.parent?.path ?? undefined,
          );
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
        } catch {
          return;
        }
      },
    });

    this.addCommand({
      id: 'insert-drawing',
      name: 'Insert drawing',
      callback: async () => {
        try {
          await insertDrawingAtCursor(this.app, this.settings, this.createDrawingUseCase, this.repo, this.surfaceManager, this.toolManager, this.documentStore);
        } catch {
          // Insertion is best-effort: a failure here must not surface as an error.
        }
      },
    });

    this.addCommand({
      id: 'insert-existing-drawing',
      name: 'Insert existing drawing',
      callback: () => {
        try {
          insertExistingDrawing(this.app, this.repo, this.settings, this.surfaceManager, this.toolManager, this.documentStore);
        } catch {
          // Best-effort like insert-drawing: a failure here must not surface as an error.
        }
      },
    });

    // Stroke history and clear, exposed as commands so they appear in the command palette
    // (and can be rebound) besides the toolbar buttons and Ctrl/Cmd+Z inside a board.
    this.addCommand({
      id: 'undo-stroke',
      name: 'Undo stroke',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BlackboardView);
        if (!view) return false;
        if (!checking) view.undo();
        return true;
      },
    });

    this.addCommand({
      id: 'redo-stroke',
      name: 'Redo stroke',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BlackboardView);
        if (!view) return false;
        if (!checking) view.redo();
        return true;
      },
    });

    this.addCommand({
      id: 'clear-board',
      name: 'Clear board',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BlackboardView);
        if (!view) return false;
        if (!checking) view.clearAll();
        return true;
      },
    });

    // No default hotkey: Obsidian exposes this command in Settings → Hotkeys so the user can
    // assign one without the plugin claiming a global combination.
    this.addCommand({
      id: 'convert-to-note',
      name: 'Caelestia-Ink: Convertir a nota',
      checkCallback: (checking) => {
        if (!this.surfaceManager.getActiveConversionTarget()) return false;
        if (!checking) void this.conversionController.start();
        return true;
      },
    });

    // Editor context-menu entry: with the no-surface pill gone from Markdown (issue #9), this
    // keeps "insert a new drawing here" discoverable right where you are typing.
    this.registerEvent(this.app.workspace.on('editor-menu', (menu) => {
      menu.addItem((item) => {
        item
          .setTitle('Insert drawing')
          .setIcon('pencil')
          .onClick(async () => {
            try {
              await insertDrawingAtCursor(this.app, this.settings, this.createDrawingUseCase, this.repo, this.surfaceManager, this.toolManager, this.documentStore);
            } catch {
              // Best-effort like the insert-drawing command.
            }
          });
      });
    }));

    this.addSettingTab(new BlackboardSettingTab(this.app, this));

    // Paint any already-mounted surfaces with the saved board background (issue #13).
    this.applyBoardBackground();

    patchCanvas(this.app, this, this.settings, this.repo, this.createDrawingUseCase, this.surfaceManager, this.toolManager, this.documentStore);

    const processEmbeds = () => {
      releaseDetachedEmbeds();
      const embeds = activeDocument.querySelectorAll('.internal-embed.mod-generic.is-loaded');
      embeds.forEach((embedEl) => {
        const src = (embedEl as HTMLElement).getAttribute('src') || '';
        if (!src.endsWith('.' + FILE_EXTENSION)) return;
        if ((embedEl as HTMLElement).dataset.bbMounted === 'true') return;
        const file = this.app.metadataCache.getFirstLinkpathDest(src, '');
        if (!file) return;
        const sizeAlias = (embedEl as HTMLElement).getAttribute('width')
          || (embedEl as HTMLElement).getAttribute('alt')
          || '';
        const size = parseEmbedSize(sizeAlias);
        if (size) {
          // Explicit |WxH / |N% alias overrides the default.
          if (size.width !== null) (embedEl as HTMLElement).style.width = size.width;
          if (size.height !== null) (embedEl as HTMLElement).style.height = size.height;
          void mountBlackboardEmbed(this.repo, embedEl as HTMLElement, file.path, this.settings, this.surfaceManager, this.toolManager, this.documentStore, () => this.markdownNotePathForElement(embedEl as HTMLElement));
        } else {
          // No alias: render at the drawing's saved size, centred, capped to the note
          // width. Reading the file first keeps the embed image-like rather than
          // stretching to full width.
          void this.applySavedEmbedSize(embedEl as HTMLElement, file.path).then(() => {
            void mountBlackboardEmbed(this.repo, embedEl as HTMLElement, file.path, this.settings, this.surfaceManager, this.toolManager, this.documentStore, () => this.markdownNotePathForElement(embedEl as HTMLElement));
          });
        }
      });
    };

    // Startup heal: any bbMounted marker present now is stale (this instance has
    // mounted nothing yet). It was left by an older version that didn't unmount on
    // unload. Clear the marker and the orphaned engine DOM so the embed can re-mount.
    for (const el of Array.from(
      activeDocument.querySelectorAll<HTMLElement>('[data-bb-mounted="true"]'),
    )) {
      el.dataset.bbMounted = 'false';
      el.empty();
    }
    // Same heal for the removed card-menu pencil button: older versions injected it into
    // canvas menus, and those menus survive plugin reloads.
    for (const el of Array.from(activeDocument.querySelectorAll('#blackboard-add-drawing'))) {
      el.remove();
    }

    // Unmount every live embed when the plugin unloads (reload/update/disable):
    // leaves the DOM re-mountable for the next instance and removes doc listeners.
    this.register(() => unmountAllEmbeds());

    this.registerEvent(this.app.workspace.on('layout-change', processEmbeds));

    const embedObserver = new MutationObserver(processEmbeds);
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      const activeEl = activeDocument.querySelector('.workspace-leaf.mod-active .view-content');
      if (activeEl && !(activeEl as HTMLElement).dataset.bbObserved) {
        (activeEl as HTMLElement).dataset.bbObserved = 'true';
        embedObserver.observe(activeEl, { childList: true, subtree: true });
      }
    }));
    this.register(() => embedObserver.disconnect());

    window.setTimeout(processEmbeds, 1000);

    const folder = this.settings.drawingFolder;
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      try {
        await this.app.vault.createFolder(folder);
      } catch {
        // Folder may already exist (vault cache lag / re-enable); ignore.
      }
    }

    this.registerEvent(this.app.vault.on('modify', async (file) => {
      if (!(file instanceof TFile) || file.extension !== FILE_EXTENSION) return;
      // External-edit channel: reconcile the on-disk content into the shared document so
      // open surfaces refresh (another device, Obsidian Sync, manual edit). The store
      // ignores content equal to its own last write, so the plugin's own saves don't loop.
      try {
        const content = await this.app.vault.read(file);
        this.documentStore.reconcile(file.path, content);
      } catch {
        // File may be mid-rename or unreadable this tick; the next modify event reconciles.
      }
      if (this.settings.autoExportSvg) {
        try { await this.exportSvgUseCase.execute(file.path, this.settings.svgExportPath); } catch {
          // Auto-export must never block or fail the save that triggered it.
        }
      }
    }));

    this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
      if (file instanceof TFile && file.extension === FILE_EXTENSION && this.settings.autoExportSvg) {
        const oldSvgPath = oldPath.replace(/\.[^.]+$/, '.svg');
        const newSvgPath = file.path.replace(/\.[^.]+$/, '.svg');
        await this.repo.rename(oldSvgPath, newSvgPath);
      }
    }));

    this.registerEvent(this.app.vault.on('delete', async (file) => {
      if (file instanceof TFile && file.extension === FILE_EXTENSION && this.settings.autoExportSvg) {
        const svgPath = file.path.replace(/\.[^.]+$/, '.svg');
        await this.repo.delete(svgPath);
      }
    }));
  }

  /** Window of the main Obsidian workspace. */
  private mainWindow(): Window {
    return this.app.workspace.containerEl.ownerDocument?.defaultView ?? window;
  }

  /** Resolve the note that owns this embed; never fall back to the globally active file. */
  private markdownNotePathForElement(element: HTMLElement): string | null {
    let notePath: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (notePath) return;
      const view = leaf.view as unknown as { containerEl?: HTMLElement; file?: TFile | null };
      if (!view.containerEl?.contains(element)) return;
      if (view.file instanceof TFile && view.file.extension === 'md') notePath = view.file.path;
    });
    return notePath;
  }

  /** Create (once) the floating toolbar that belongs to `win`. */
  private ensureToolbar(win: Window): GlobalToolbar {
    const existing = this.toolbars.get(win);
    if (existing) return existing;

    const host = win === this.mainWindow()
      ? this.app.workspace.containerEl
      : (win.document.querySelector<HTMLElement>('.workspace') ?? win.document.body);
    const toolbar = new GlobalToolbar(host, this.surfaceManager, () => {
      void insertDrawingAtCursor(this.app, this.settings, this.createDrawingUseCase, this.repo, this.surfaceManager, this.toolManager, this.documentStore);
    }, () => {
      insertExistingDrawing(this.app, this.repo, this.settings, this.surfaceManager, this.toolManager, this.documentStore);
    }, this.settings, (position) => {
      this.settings.toolbarPosition = position;
      void this.saveSettings();
    }, (surface) => {
      void this.conversionController.start(surface);
    });
    this.toolbars.set(win, toolbar);
    return toolbar;
  }

  /** Window that owns a leaf, read from its container element. */
  private leafWindow(leaf: WorkspaceLeaf): Window | undefined {
    const view = leaf.view as unknown as { containerEl?: HTMLElement } | undefined;
    return view?.containerEl?.ownerDocument?.defaultView ?? undefined;
  }

  /**
   * Leaf that is genuinely in front in `win`. `workspace.activeLeaf` is authoritative and is
   * updated by Obsidian before the `mod-active` class moves, so relying on the DOM alone made
   * `active-leaf-change` re-activate the outgoing drawing while the incoming note was already
   * visible. Popouts (and windows Obsidian is not tracking) fall back to the leaf that holds
   * focus, then to the class-marked leaf.
   */
  private activeLeafInWindow(win: Window): WorkspaceLeaf | null {
    const workspace = this.app.workspace;
    const active = workspace.activeLeaf ?? null;
    if (active && this.leafWindow(active) === win) return active;
    const focusedEl = win.document.activeElement;
    let byFocus: WorkspaceLeaf | null = null;
    let byClass: WorkspaceLeaf | null = null;
    workspace.iterateAllLeaves((leaf) => {
      if (this.leafWindow(leaf) !== win) return;
      const container = (leaf.view as unknown as { containerEl?: HTMLElement } | undefined)?.containerEl;
      if (!container) return;
      if (focusedEl && container.contains(focusedEl)) byFocus = leaf;
      const leafEl = container.closest<HTMLElement>('.workspace-leaf') ?? container;
      if (leafEl.classList.contains('mod-active')) byClass = leaf;
    });
    return byFocus ?? byClass ?? null;
  }

  /** Content element and view type of the active leaf inside a given window. */
  private activeViewInWindow(win: Window): { contentEl: HTMLElement; viewType: string } | null {
    const preferred = this.activeLeafInWindow(win);
    const read = (leaf: WorkspaceLeaf | null): { contentEl: HTMLElement; viewType: string } | null => {
      if (!leaf) return null;
      const view = leaf.view as unknown as
        | { contentEl?: HTMLElement; getViewType?: () => string }
        | undefined;
      const contentEl = view?.contentEl;
      if (!contentEl || !contentEl.isConnected) return null;
      if (contentEl.ownerDocument?.defaultView !== win) return null;
      return { contentEl, viewType: view?.getViewType?.() ?? '' };
    };
    const direct = read(preferred);
    if (direct) return direct;

    let found: { contentEl: HTMLElement; viewType: string } | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view as unknown as
        | { contentEl?: HTMLElement; containerEl?: HTMLElement; getViewType?: () => string }
        | undefined;
      const contentEl = view?.contentEl;
      if (!contentEl || contentEl.ownerDocument?.defaultView !== win) return;
      const leafEl = view?.containerEl?.closest('.workspace-leaf') ?? view?.containerEl;
      if (!leafEl?.classList.contains('mod-active')) return;
      found = { contentEl, viewType: view?.getViewType?.() ?? '' };
    });
    return found;
  }

  private repositionToolbars(): void {
    for (const toolbar of this.toolbars.values()) toolbar.reposition();
  }

  /**
   * Route each window's toolbar to that window's active view. A popout keeps its own
   * toolbar even when the main window opens a note, because `activateForView` is only
   * driven by the focused window; every other toolbar falls back to the drawing in its
   * own document (SurfaceManager.surfaceForDocument).
   */
  private routeToolbar(leaf?: WorkspaceLeaf | null): void {
    const focusWin = leaf?.view?.containerEl?.ownerDocument?.defaultView
      ?? activeWindow
      ?? this.mainWindow();

    for (const [win, toolbar] of this.toolbars) {
      const info = this.activeViewInWindow(win);
      toolbar.setSurfaceBindingEnabled(info?.viewType !== 'markdown');
      // Persistent pill: only Canvas hosts the collapsed no-surface pill (issue #9). Set the
      // host before activating so the no-surface fallback anchors correctly.
      toolbar.setHost(info && isPillHostViewType(info.viewType) ? info.contentEl : null);
    }

    const focused = this.activeViewInWindow(focusWin);
    this.surfaceManager.activateForView(focused?.contentEl ?? null);
    // The active surface can stay the same while the visible view changes (a drawing tab left
    // open behind a note, a same-leaf view replacement). Re-resolve every toolbar so none
    // stays bound to a drawing that is no longer on screen.
    for (const toolbar of this.toolbars.values()) toolbar.refreshBinding();
  }

  /**
   * Size a no-alias Markdown embed to the drawing's saved dimensions, centred, and
   * scaled down to fit the note's content width when wider. An explicit `|WxH` alias
   * skips this (handled by the caller).
   */
  private async applySavedEmbedSize(embedEl: HTMLElement, filePath: string): Promise<void> {
    try {
      const { file } = await this.repo.load(filePath);
      const avail = embedEl.parentElement?.clientWidth || embedEl.clientWidth || file.width || 0;
      const fit = fitSavedEmbedSize(file.width || 0, file.height || 0, avail);
      if (!fit) return;
      embedEl.setCssStyles({
        width: fit.width + 'px',
        height: fit.height + 'px',
        marginLeft: 'auto',
        marginRight: 'auto',
      });
    } catch {
      // Couldn't read the file; leave the embed at its default size.
    }
  }

  /** Load the selected local recognizer only when the user explicitly starts a conversion. */
  private async loadRecognitionUseCase(): Promise<ConvertBlackboardUseCase | null> {
    if (this.settings.recognitionEngine === 'disabled') return null;
    if (this.settings.recognitionEngine === 'ollama') {
      const [{ OllamaOcrEngine }, { CanvasReferenceRenderer }] = await Promise.all([
        import('./infrastructure/recognition/ollama-ocr-engine'),
        import('./infrastructure/recognition/reference-renderer'),
      ]);
      return new ConvertBlackboardUseCase(
        new SvgRegionExporter(),
        new OllamaOcrEngine(new CanvasReferenceRenderer(), {
          baseUrl: this.settings.ollamaBaseUrl,
          model: this.settings.ollamaModel,
          timeoutMs: this.settings.ollamaTimeoutSeconds * 1000,
          maxRetries: this.settings.ollamaMaxRetries,
        }),
      );
    }
    const pythonPath = this.settings.mathNotePythonPath.trim();
    if (!pythonPath || !Platform.isDesktopApp) return null;
    const { MathNoteEngine } = await import('./infrastructure/recognition/mathnote-engine');
    return new ConvertBlackboardUseCase(
      new SvgRegionExporter(),
      new MathNoteEngine({ pythonPath }),
    );
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_PLUGIN_SETTINGS, await this.loadData() as Partial<PluginSettings>);
    this.validateSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Reflect the persistent-pill toggle immediately so a Canvas with no active surface
    // hides (or restores) the pill without needing a view switch.
    for (const toolbar of this.toolbars.values()) toolbar.setPillEnabled(this.settings.showToolbarPill);
    // Apply a saved toolbar position (drag reset or settings reload) without waiting for a
    // view switch.
    for (const toolbar of this.toolbars.values()) toolbar.setPosition(this.settings.toolbarPosition);
    // Re-paint every mounted surface so a board-background change is live (issue #13).
    this.applyBoardBackground();
  }

  /** Paint every mounted drawing surface with the configured board background (issue #13). */
  private applyBoardBackground(): void {
    const color = this.settings.boardBackground;
    for (const el of Array.from(
      activeDocument.querySelectorAll<HTMLElement>('.blackboard-drawing-container'),
    )) {
      el.style.backgroundColor = color;
    }
  }

  private validateSettings(): void {
    this.settings = validateSettings(this.settings);
  }
}
