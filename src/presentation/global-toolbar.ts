import iro from '@jaames/iro';
import type { SurfaceManager } from './surface-manager';
import type { DrawingSurface, ToolName } from './drawing-surface';
import { setToolbarIcon, setSizeDotIcon, type IconName } from './toolbar-icons';
import type { PluginSettings, ToolbarPosition } from '../domain/entities';
import { DEFAULT_PLUGIN_SETTINGS } from '../domain/entities';
import type { IroColorPickerLike, IroModuleLike } from '../types/obsidian-internals';

const TOOLS: Array<{ name: ToolName; icon: IconName; label: string }> = [
  { name: 'pen', icon: 'pen', label: 'Pen' },
  { name: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { name: 'eraser', icon: 'eraser', label: 'Eraser' },
];
// Pen and eraser share the finer pen scale; the highlighter gets its own markedly wider
// scale so a marker reads like a marker rather than a fat pen. Each is five presets.
const PEN_SIZES = [2, 4, 8, 16, 30];
const HIGHLIGHTER_SIZES = [8, 14, 22, 32, 44];

/**
 * Floating toolbar for one Obsidian window. The plugin creates one per window (main and
 * every popout), so a drawing moved to another window keeps its controls instead of
 * depending on the main window's active view. Within a window it follows the active
 * drawing surface (SurfaceManager), collapses to a pill on the right edge, and with no
 * active drawing shows only the collapsed pill on a Canvas and nothing anywhere else.
 */
export class GlobalToolbar {
  private root: HTMLElement;
  private pill: HTMLElement;
  private toolButtons = new Map<ToolName, HTMLElement>();
  private colorWell!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private zoomButtons: HTMLButtonElement[] = [];
  private colorPopover!: HTMLElement;
  private sizePopover!: HTMLElement;
  private sizeRow!: HTMLElement;
  private sizeBtn!: HTMLElement;
  // iro.ColorPicker, typed loosely because iro ships no strict types to import
  private picker: IroColorPickerLike | null = null;
  private surface: DrawingSurface | null = null;
  private anchorEl: HTMLElement | null = null;
  // Anchor for the persistent pill on a Canvas view that has no active surface yet. null on
  // every other view type (Markdown, graph, settings, ...) so the pill stays hidden there.
  private hostEl: HTMLElement | null = null;
  // Controls that only act on an active surface; disabled in the no-surface (host-only) state.
  private surfaceControls: HTMLButtonElement[] = [];
  private collapsed = false;
  // Gates the persistent no-surface pill on Canvas hosts (settings.showToolbarPill).
  // When false, a host with no active surface shows nothing; an active surface is unaffected.
  private pillEnabled = true;
  // True while the collapse is forced by the no-surface pill (not chosen by the user), so a
  // newly-activated drawing knows to expand rather than inherit the empty-page pill.
  private pillForcedByNoSurface = false;
  // Markdown notes may contain drawing embeds, but their floating Blackboard controls must
  // not cover the note. Routing disables surface binding without modifying the embed itself.
  private surfaceBindingEnabled = true;
  private unsub: () => void;
  private unsubStroke: () => void;
  private unsubStrokeEnd: () => void;
  private onResize: () => void;
  private onKeyDown: (e: KeyboardEvent) => void;
  // iPad home-indicator inset; the toolbar is kept above this to avoid clipping.
  private safeBottom = 0;
  // User-chosen position (normalized 0..1) and the pixel position while a mouse drag is in
  // progress. Null position means the default bottom-centre placement.
  private position: ToolbarPosition | null;
  private dragPos: { left: number; top: number } | null = null;
  private dragHandle!: HTMLButtonElement;
  private endDrag: (() => void) | null = null;

  // The eight color-popover shortcuts in display order, sourced from plugin settings.
  private readonly paletteColors: string[];

  /** Document that owns this toolbar: one instance lives in each Obsidian window. */
  private get doc(): Document {
    return this.host.ownerDocument;
  }

  /** Window that owns this toolbar; resize and viewport math must use it, not the main one. */
  private get win(): Window {
    return this.doc.defaultView ?? window;
  }

  constructor(private host: HTMLElement, private manager: SurfaceManager, private onNewDrawing?: () => void, private onInsertExisting?: () => void, settings?: PluginSettings, private onPositionChange?: (position: ToolbarPosition | null) => void, private onConvert?: (surface: DrawingSurface) => void) {
    this.paletteColors = settings?.paletteColors ?? DEFAULT_PLUGIN_SETTINGS.paletteColors;
    this.pillEnabled = settings?.showToolbarPill ?? DEFAULT_PLUGIN_SETTINGS.showToolbarPill;
    this.position = settings?.toolbarPosition ?? null;
    this.root = host.createDiv({ cls: 'blackboard-global-toolbar' });
    this.pill = host.createDiv({ cls: 'blackboard-global-toolbar-pill' });
    this.build();
    // The full toolbar can be dragged by mouse, or by touch from its explicit grip. The
    // collapsed pill stays pinned to the right edge. Pen drag is intentionally not allowed.
    this.pill.addEventListener('click', (e) => { e.stopPropagation(); this.setCollapsed(false); });
    this.hide();
    this.unsub = manager.onChange((s, el) => this.onSurfaceChange(s, el));
    // Starting to draw closes any open popover.
    this.unsubStroke = manager.onStrokeStart(() => this.closePopovers());
    // Finishing a stroke re-syncs derived controls (notably undo/redo enablement) so the
    // undo arrow lights up immediately after the first stroke, not on the next tap.
    this.unsubStrokeEnd = manager.onStrokeEnd(() => this.sync());
    this.measureSafeBottom();
    this.onResize = () => { this.measureSafeBottom(); this.reposition(); };
    this.win.addEventListener('resize', this.onResize);
    // The iPad floating mini-keyboard and orientation changes resize/scroll the VISUAL
    // viewport (not the layout viewport), so window 'resize' alone misses them and the
    // toolbar drifts off-centre. Re-centre on those too.
    this.win.addEventListener('orientationchange', this.onResize);
    if (this.win.visualViewport) {
      this.win.visualViewport.addEventListener('resize', this.onResize);
      this.win.visualViewport.addEventListener('scroll', this.onResize);
    }
    this.onKeyDown = (e) => this.handleToolShortcut(e);
    this.doc.addEventListener('keydown', this.onKeyDown, true);
    // Bind to whatever drawing already lives in this window (the toolbar is created after
    // the popout's leaf, so waiting for the next change would leave it hidden).
    this.onSurfaceChange(manager.getActive(), manager.getActiveElement());
  }

  /** Read env(safe-area-inset-bottom) via a probe so the palette clears the
   * iPad home indicator. Zero on desktop. */
  private measureSafeBottom(): void {
    const probe = this.doc.body.createDiv({ cls: 'blackboard-safe-area-probe' });
    this.safeBottom = probe.getBoundingClientRect().height || 0;
    probe.remove();
  }

  private build(): void {
    // Grip: mouse or touch drag handle. Pen never starts a drag, so Apple Pencil hover
    // cannot jitter the toolbar while drawing.
    this.dragHandle = this.root.createEl('button');
    this.dragHandle.className = 'blackboard-gt-drag';
    this.dragHandle.setAttribute('aria-label', 'Move toolbar');
    this.dragHandle.setAttribute('title', 'Drag to move. Double-click to reset.');
    setToolbarIcon(this.dragHandle, 'grip');
    this.dragHandle.addEventListener('pointerdown', (e) => this.startDrag(e));
    this.dragHandle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.commitPosition(null);
    });
    // Dragging from the toolbar background, padding or a separator also moves it; controls
    // keep their normal click behavior.
    this.root.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('button')) return;
      this.startDrag(e);
    });

    for (const t of TOOLS) {
      const shortcut = String(TOOLS.indexOf(t) + 1);
      const btn = this.iconButton(t.icon, t.label, shortcut);
      btn.dataset.tool = t.name;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectTool(t.name);
      });
      this.toolButtons.set(t.name, btn);
      this.surfaceControls.push(btn);
    }
    this.separator();

    this.colorWell = this.root.createEl('button');
    // Spectrum-only: the conic rainbow fills the whole well, with no center-color dot.
    this.colorWell.className = 'blackboard-gt-swatch blackboard-gt-colorwell';
    this.colorWell.setAttribute('aria-label', 'Color');
    this.colorWell.addEventListener('click', (e) => {
      e.stopPropagation();
      // The eraser has no color, so the color picker is a no-op while it is active.
      if (this.surface?.activeTool === 'eraser') return;
      this.togglePopover('color');
    });
    this.surfaceControls.push(this.colorWell as HTMLButtonElement);

    const sizeBtn = this.iconButton('size', 'Brush size');
    sizeBtn.classList.add('blackboard-gt-size-btn');
    sizeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.togglePopover('size'); });
    this.surfaceControls.push(sizeBtn);
    this.sizeBtn = sizeBtn;
    this.separator();

    this.undoBtn = this.iconButton('undo', 'Undo');
    this.undoBtn.dataset.action = 'undo';
    this.undoBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closePopovers(); this.surface?.undo(); this.sync(); });
    this.surfaceControls.push(this.undoBtn);
    this.redoBtn = this.iconButton('redo', 'Redo');
    this.redoBtn.dataset.action = 'redo';
    this.redoBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closePopovers(); this.surface?.redo(); this.sync(); });
    this.surfaceControls.push(this.redoBtn);
    this.clearBtn = this.iconButton('trash', 'Clear board');
    this.clearBtn.dataset.action = 'clear';
    this.clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopovers();
      this.surface?.clearAll();
      this.sync();
    });
    this.surfaceControls.push(this.clearBtn);
    this.separator();

    const zoomOutBtn = this.iconButton('zoom-out', 'Zoom out');
    zoomOutBtn.dataset.action = 'zoom-out';
    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopovers();
      this.surface?.zoomOut?.();
    });
    const resetViewBtn = this.iconButton('fit-view', 'Fit drawing');
    resetViewBtn.dataset.action = 'reset-view';
    resetViewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopovers();
      this.surface?.resetView?.();
    });
    const zoomInBtn = this.iconButton('zoom-in', 'Zoom in');
    zoomInBtn.dataset.action = 'zoom-in';
    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopovers();
      this.surface?.zoomIn?.();
    });
    this.zoomButtons = [zoomOutBtn, resetViewBtn, zoomInBtn];
    this.surfaceControls.push(...this.zoomButtons);
    this.separator();

    const convertBtn = this.iconButton('convert', 'Convertir a nota');
    convertBtn.dataset.action = 'convert-to-note';
    convertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopovers();
      // Without a bound surface there is nothing to convert; never fall back to another pane.
      if (this.surface) this.onConvert?.(this.surface);
    });
    this.surfaceControls.push(convertBtn);
    this.separator();

    const newBtn = this.iconButton('plus', 'New drawing');
    newBtn.dataset.action = 'new-drawing';
    newBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closePopovers(); this.onNewDrawing?.(); });

    const insertBtn = this.iconButton('insert-existing', 'Insert existing drawing');
    insertBtn.dataset.action = 'insert-existing';
    insertBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closePopovers(); this.onInsertExisting?.(); });
    this.separator();

    const collapseBtn = this.iconButton('collapse', 'Minimize toolbar');
    collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); this.setCollapsed(true); });

    this.buildColorPopover();
    this.buildSizePopover();
  }

  private buildColorPopover(): void {
    this.colorPopover = this.host.createDiv({ cls: 'blackboard-gt-popover blackboard-gt-color-popover' });
    this.colorPopover.setCssStyles({ display: 'none' });
    this.colorPopover.addEventListener('pointerdown', (e) => e.stopPropagation());

    const swatches = this.colorPopover.createDiv({ cls: 'blackboard-gt-swatches' });
    // The eight swatches are pure shortcuts sourced from settings.paletteColors, in order.
    for (const color of this.paletteColors) {
      const sw = swatches.createEl('button');
      sw.className = 'blackboard-gt-swatch';
      sw.style.backgroundColor = color;
      sw.addEventListener('click', (e) => { e.stopPropagation(); this.pickColor(color); });
    }

    const wheel = this.colorPopover.createDiv({ cls: 'blackboard-gt-wheel' });
    try {
      const I = iro as IroModuleLike;
      this.picker = I.ColorPicker(wheel, {
        width: 150,
        color: '#ffffff',
        layout: [
          { component: I.ui.Wheel },
          { component: I.ui.Slider, options: { sliderType: 'value' } },
        ],
      });
      this.picker.on('color:change', (c: { hexString: string }) => {
        this.handleWheelColor(c.hexString);
      });
    } catch {
      this.picker = null;
    }
  }

  private buildSizePopover(): void {
    this.sizePopover = this.host.createDiv({ cls: 'blackboard-gt-popover blackboard-gt-size-popover' });
    this.sizePopover.setCssStyles({ display: 'none' });
    this.sizePopover.addEventListener('pointerdown', (e) => e.stopPropagation());
    const label = this.sizePopover.createDiv({ cls: 'blackboard-gt-popover-label' });
    label.textContent = 'Brush size';
    this.sizeRow = this.sizePopover.createDiv({ cls: 'blackboard-gt-size-row' });
    this.rebuildSizeDots();
  }

  /** The preset size scale for the active tool: the highlighter's own wider scale, else the
   * shared pen scale (also used by the eraser). */
  private presetsForActiveTool(): number[] {
    return this.surface?.activeTool === 'highlighter' ? HIGHLIGHTER_SIZES : PEN_SIZES;
  }

  /** (Re)build the popover dots for the active tool's preset scale, then highlight the dot
   * matching the active size. Called on build and each time the size popover opens, so
   * switching tools swaps the pen scale for the highlighter scale. */
  private rebuildSizeDots(): void {
    const sizes = this.presetsForActiveTool();
    this.sizeRow.empty();
    const min = sizes[0];
    const max = sizes[sizes.length - 1];
    for (const size of sizes) {
      const dot = this.sizeRow.createEl('button');
      dot.className = 'blackboard-gt-size-dot';
      dot.dataset.size = String(size);
      const inner = dot.createDiv({ cls: 'blackboard-gt-size-dot-inner' });
      // Grade the dot diameter within the active scale (6px smallest to 22px largest) so every
      // dot is visibly distinct. Under the absolute mapping (sizeToDotDiameter) the
      // highlighter's top three sizes would all clamp to 22px.
      const t = max === min ? 0 : (size - min) / (max - min);
      const d = Math.round(6 + t * 16);
      inner.style.width = `${d}px`;
      inner.style.height = `${d}px`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.surface?.setSize(size);
        this.sync();
        // Picking a size is a committed choice, so close the popover.
        this.closePopovers();
      });
    }
    this.refreshSizeDots();
  }

  private onSurfaceChange(s: DrawingSurface | null, el: HTMLElement | null): void {
    const local = this.localSurface(s, el);
    this.surface = local?.surface ?? null;
    if (local) {
      // Anchor to the active view's content area so the toolbar never bleeds over sidebars.
      this.anchorEl = local.el.closest<HTMLElement>('.view-content') ?? local.el;
      // A real drawing means the full toolbar, not the pill. If only the no-surface pill was
      // showing (forced collapsed), expand now, but keep a user's own collapse choice when
      // switching between two actual drawings.
      if (this.pillForcedByNoSurface) this.collapsed = false;
      this.pillForcedByNoSurface = false;
      this.setSurfaceControlsEnabled(true);
      // No state is pushed onto the surface: every surface already shares the one
      // ToolManager, so binding simply reflects the global selection (sync()).
      this.show();
      this.sync();
    } else {
      // No active surface: fall back to a persistent pill if the current view is a drawing host.
      this.refreshNoSurface();
    }
  }

  /**
   * Pick the surface this toolbar should drive. The manager's active surface only wins while
   * it still lives in this window's visible view; otherwise each window falls back to the
   * drawing inside its own active view, so a popout keeps its toolbar while the main window
   * shows a note, and no toolbar survives after the drawing's view is replaced.
   */
  private localSurface(
    s: DrawingSurface | null,
    el: HTMLElement | null,
  ): { surface: DrawingSurface; el: HTMLElement } | null {
    if (!this.surfaceBindingEnabled) return null;
    if (s && el && el.ownerDocument === this.doc) {
      const activeView = this.manager.resolveActiveView(this.doc);
      // No workspace DOM yet (startup/tests): trust the manager's active surface.
      if (!activeView || activeView.contains(el)) return { surface: s, el };
    }
    return this.manager.surfaceForDocument(this.doc);
  }

  /**
   * Re-resolve the surface this toolbar drives without touching user state (collapse choice,
   * drag position, open popovers). `routeToolbar` calls it on every routing pass because the
   * visible view can change without the manager's active surface changing, and the manager
   * only notifies when the surface itself changes.
   */
  refreshBinding(): void {
    const next = this.localSurface(this.manager.getActive(), this.manager.getActiveElement());
    if ((next?.surface ?? null) === this.surface) return;
    this.onSurfaceChange(this.manager.getActive(), this.manager.getActiveElement());
  }

  /** Allow drawing controls only in view types that intentionally host the global toolbar. */
  setSurfaceBindingEnabled(enabled: boolean): void {
    if (this.surfaceBindingEnabled === enabled) return;
    this.surfaceBindingEnabled = enabled;
    this.closePopovers();
    this.onSurfaceChange(this.manager.getActive(), this.manager.getActiveElement());
  }

  /** Tell the toolbar which Canvas view content to anchor the persistent pill to when no
   * surface is active. Pass null on every other view (no pill there). */
  setHost(anchorEl: HTMLElement | null): void {
    // Routing is per window; ignore an anchor from another document.
    if (anchorEl && anchorEl.ownerDocument !== this.doc) return;
    this.hostEl = anchorEl ? ((anchorEl.closest('.view-content')) ?? anchorEl) : null;
    if (!this.surface) this.refreshNoSurface();
  }

  /** Enable/disable the persistent no-surface pill (settings.showToolbarPill). Disabling it
   * hides the pill on a host with no active surface; an active surface is unaffected. */
  setPillEnabled(enabled: boolean): void {
    this.pillEnabled = enabled;
    if (!this.surface) this.refreshNoSurface();
  }

  /** No active surface: show a collapsed pill anchored to the host (if any), else hide. The
   * no-surface toolbar keeps New drawing, Insert existing drawing and Minimize enabled; every
   * control that needs a drawing is disabled. When the persistent pill is disabled
   * (settings.showToolbarPill === false), the host shows nothing: no pill and no toolbar. */
  private refreshNoSurface(): void {
    if (this.hostEl && this.pillEnabled) {
      this.anchorEl = this.hostEl;
      this.collapsed = true;
      this.pillForcedByNoSurface = true;
      this.setSurfaceControlsEnabled(false);
      this.show();
    } else {
      this.setSurfaceControlsEnabled(false);
      this.hide();
    }
  }

  private setSurfaceControlsEnabled(enabled: boolean): void {
    for (const btn of this.surfaceControls) btn.disabled = !enabled;
    if (!enabled) {
      for (const btn of this.zoomButtons) btn.hidden = true;
    }
  }

  private anchorRect(): DOMRect {
    return (this.anchorEl ?? this.host).getBoundingClientRect();
  }

  /** Usable region: the active view's rect, intersected with the visible viewport
   * (minus the bottom safe-area inset) and inset by a 12px margin. */
  private bounds(): { left: number; right: number; top: number; bottom: number } {
    const r = this.anchorRect();
    // Clamp to the VISIBLE viewport bottom (visualViewport excludes the floating
    // mini-keyboard) so the toolbar stays above the keyboard rather than behind it;
    // fall back to the layout viewport when visualViewport is unavailable.
    const vv = this.win.visualViewport;
    const visibleBottom = vv ? vv.offsetTop + vv.height : this.win.innerHeight;
    let bottom = Math.min(r.bottom, visibleBottom - this.safeBottom) - 12;
    // Keep clear of Obsidian's native Canvas card menu (also bottom-centred), on any
    // device/size, by sitting above it whenever it is present and visible.
    const cardMenu = this.anchorEl?.querySelector('.canvas-card-menu') as HTMLElement | null;
    if (cardMenu) {
      const cm = cardMenu.getBoundingClientRect();
      if (cm.height > 0 && cm.top < bottom) bottom = cm.top - 8;
    }
    return {
      left: r.left + 12,
      right: r.right - 12,
      top: Math.max(r.top, 0) + 12,
      bottom,
    };
  }

  /** Re-pin the toolbar/pill to their fixed positions (call on resize or layout change).
   * Idempotent: repeated calls do not jiggle the toolbar. */
  reposition(): void {
    if (!this.surface && !this.hostEl) return;
    if (this.collapsed) this.placePill();
    else this.placeToolbar();
  }

  /** Apply a saved normalized position (or null for the default) and re-place the toolbar. */
  setPosition(position: ToolbarPosition | null): void {
    this.position = position
      ? { x: Math.min(1, Math.max(0, position.x)), y: Math.min(1, Math.max(0, position.y)) }
      : null;
    this.dragPos = null;
    this.reposition();
  }

  /** Store a position chosen by the user and notify the plugin so it can persist it. */
  private commitPosition(position: ToolbarPosition | null): void {
    this.position = position;
    this.dragPos = null;
    this.onPositionChange?.(position);
    this.reposition();
  }

  /** Begin a drag. Mouse may drag from the grip or toolbar background; touch must start on
   * the explicit grip; pen is always ignored to avoid Apple Pencil hover jitter. */
  private startDrag(e: PointerEvent): void {
    const fromGrip = !!(e.target as HTMLElement | null)?.closest?.('.blackboard-gt-drag');
    if (
      e.button !== 0 ||
      e.pointerType === 'pen' ||
      (e.pointerType === 'touch' && !fromGrip) ||
      this.endDrag
    ) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = this.root.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    let moved = false;

    const doc = this.dragHandle.ownerDocument;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      this.dragPos = { left: startLeft + dx, top: startTop + dy };
      this.placeToolbar();
    };

    const cleanup = () => {
      doc.removeEventListener('pointermove', onMove, true);
      doc.removeEventListener('pointerup', onUp, true);
      doc.removeEventListener('pointercancel', onUp, true);
      this.endDrag = null;
    };

    const onUp = () => {
      const wasMoved = moved;
      cleanup();
      if (wasMoved) {
        this.commitDragPosition();
      } else {
        this.dragPos = null;
        this.placeToolbar();
      }
    };

    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onUp, true);
    this.endDrag = cleanup;
  }

  /** Convert the dropped pixel position back to normalized coordinates and persist it. */
  private commitDragPosition(): void {
    const b = this.bounds();
    const w = this.root.offsetWidth || 220;
    const h = this.root.offsetHeight || 48;
    const maxLeft = Math.max(b.left, b.right - w);
    const maxTop = Math.max(b.top, b.bottom - h);
    const left = Number.parseFloat(this.root.style.left);
    const top = Number.parseFloat(this.root.style.top);
    const x = maxLeft > b.left && Number.isFinite(left)
      ? (left - b.left) / (maxLeft - b.left)
      : 0.5;
    const y = maxTop > b.top && Number.isFinite(top)
      ? (top - b.top) / (maxTop - b.top)
      : 1;
    this.dragPos = null;
    this.commitPosition({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
  }

  /** Toolbar: bottom-centre by default, or the user's dragged position when set. */
  private placeToolbar(): void {
    const b = this.bounds();
    this.root.style.maxWidth = `${Math.max(120, b.right - b.left)}px`;
    const w = this.root.offsetWidth || 220;
    const h = this.root.offsetHeight || 48;
    const maxLeft = Math.max(b.left, b.right - w);
    const maxTop = Math.max(b.top, b.bottom - h);

    let left: number;
    let top: number;
    if (this.dragPos) {
      left = this.dragPos.left;
      top = this.dragPos.top;
    } else if (this.position) {
      left = b.left + this.position.x * (maxLeft - b.left);
      top = b.top + this.position.y * (maxTop - b.top);
    } else {
      left = (b.left + b.right) / 2 - w / 2;
      top = b.bottom - h;
    }

    this.root.style.left = `${Math.min(maxLeft, Math.max(b.left, Math.round(left)))}px`;
    this.root.style.top = `${Math.min(maxTop, Math.max(b.top, Math.round(top)))}px`;
  }

  /** Pill: always pinned to the right edge, vertically centred. */
  private placePill(): void {
    const b = this.bounds();
    const s = this.pill.offsetWidth || 56;
    this.pill.style.left = `${Math.max(b.left, b.right - s)}px`;
    this.pill.style.top = `${Math.max(b.top, Math.round((b.top + b.bottom) / 2 - s / 2))}px`;
  }

  private sync(): void {
    if (!this.surface) return;
    for (const [name, btn] of this.toolButtons) {
      btn.classList.toggle('active', name === this.surface.activeTool);
    }
    this.updateToolTints();
    this.updateSizeIcon();
    this.undoBtn.disabled = !this.surface.canUndo();
    this.redoBtn.disabled = !this.surface.canRedo();
    const navigationAvailable = !!(
      this.surface.zoomIn && this.surface.zoomOut && this.surface.resetView
    );
    for (const btn of this.zoomButtons) {
      btn.hidden = !navigationAvailable;
      btn.disabled = !navigationAvailable;
    }
    this.refreshSizeDots();
    if (this.collapsed) this.updatePillIcon();
  }

  /** Highlight the size dot whose `data-size` equals the active tool's current size. */
  private refreshSizeDots(): void {
    if (!this.surface) return;
    const active = this.surface.activeSize;
    for (const dot of Array.from(this.sizePopover.querySelectorAll<HTMLElement>('.blackboard-gt-size-dot'))) {
      dot.classList.toggle('active', Number(dot.dataset.size) === active);
    }
  }

  /** White circle on the size button, scaled to the active tool's current brush size. */
  private updateSizeIcon(): void {
    if (!this.surface) return;
    setSizeDotIcon(this.sizeBtn, this.surface.activeSize);
  }

  /** Tint the pen/highlighter glyphs to their tool's colour. The eraser has no colour, so its
   * glyph is left untinted, and selecting the eraser never disturbs the pen/highlighter tints. */
  private updateToolTints(): void {
    if (!this.surface) return;
    const pen = this.toolButtons.get('pen');
    const highlighter = this.toolButtons.get('highlighter');
    if (pen) pen.style.color = this.surface.penColor;
    if (highlighter) highlighter.style.color = this.surface.highlighterColor;
  }

  /** Wheel path: arbitrary colors set the active tool color but never rewrite
   * paletteColors. Re-tint immediately: waiting for the next sync() (tool switch)
   * left the glyph showing the old color. */
  private handleWheelColor(hex: string): void {
    this.surface?.setColor(hex);
    this.updateToolTints();
  }

  private pickColor(color: string): void {
    this.surface?.setColor(color);
    // Re-tint immediately: color changes don't run sync().
    this.updateToolTints();
    if (this.picker) { try { this.picker.color.hexString = color; } catch { /* ignore */ } }
    // Selecting a preset swatch is a committed choice, so close the popover.
    this.closePopovers();
  }

  private togglePopover(which: 'color' | 'size'): void {
    const target = which === 'color' ? this.colorPopover : this.sizePopover;
    const other = which === 'color' ? this.sizePopover : this.colorPopover;
    other.setCssStyles({ display: 'none' });
    const open = target.style.display === 'none';
    this.closePopovers();
    if (open) {
      target.setCssStyles({ display: '' });
      if (which === 'color' && this.picker && this.surface) {
        try { this.picker.color.hexString = this.surface.activeColor; } catch { /* ignore */ }
      }
      // When the size popover opens, (re)build its dots for the active tool's scale (pen vs
      // highlighter) and highlight the dot matching the active size. Otherwise sync() only
      // runs on selection.
      if (which === 'size') this.rebuildSizeDots();
      this.positionPopover(target);
    }
  }

  private closePopovers(): void {
    this.colorPopover.setCssStyles({ display: 'none' });
    this.sizePopover.setCssStyles({ display: 'none' });
  }

  /** Select a tool through the same path for pointer activation and numeric shortcuts. */
  private selectTool(tool: ToolName): void {
    if (!this.surface) return;
    // Each tool keeps its own colour. Before leaving a coloured tool for the eraser, commit
    // the wheel's in-progress value while the previous tool is still active.
    const prevTool = this.surface.activeTool;
    if (
      tool === 'eraser' &&
      this.colorPopover.style.display !== 'none' &&
      (prevTool === 'pen' || prevTool === 'highlighter')
    ) {
      this.surface.setColor(this.surface.activeColor);
    }
    this.surface.setTool(tool);
    this.sync();
    this.closePopovers();
  }

  /** Unmodified 1/2/3 select pen/highlighter/eraser while a drawing in this window is active. */
  private handleToolShortcut(e: KeyboardEvent): void {
    if (!this.surface || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const tool = e.code === 'Digit1' || e.code === 'Numpad1'
      ? 'pen'
      : e.code === 'Digit2' || e.code === 'Numpad2'
        ? 'highlighter'
        : e.code === 'Digit3' || e.code === 'Numpad3'
          ? 'eraser'
          : null;
    if (!tool) return;
    e.preventDefault();
    e.stopPropagation();
    this.selectTool(tool);
  }

  private positionPopover(p: HTMLElement): void {
    // position:fixed in viewport coords; anchored above the toolbar and clamped
    // horizontally within the active view so it doesn't overflow sidebars.
    const r = this.root.getBoundingClientRect();
    const a = this.anchorRect();
    const left = Math.min(Math.max(a.left + 8, r.left), a.right - p.offsetWidth - 8);
    p.style.left = `${Math.max(8, left)}px`;
    p.style.top = `${Math.max(8, r.top - p.offsetHeight - 8)}px`;
  }

  private setCollapsed(c: boolean): void {
    this.collapsed = c;
    // An explicit collapse/expand is the user taking control; stop treating it as the forced pill.
    this.pillForcedByNoSurface = false;
    this.closePopovers();
    // Allow expand/collapse in the host-only (no-surface) state too, not just when drawing.
    if (!this.surface && !this.hostEl) return;
    this.root.setCssStyles({ display: c ? 'none' : '' });
    this.pill.setCssStyles({ display: c ? '' : 'none' });
    if (c) { this.updatePillIcon(); this.placePill(); }
    else this.placeToolbar();
  }

  private updatePillIcon(): void {
    const tool = this.surface?.activeTool ?? 'pen';
    const icon = TOOLS.find((t) => t.name === tool)?.icon ?? 'pen';
    setToolbarIcon(this.pill, icon);
  }

  private show(): void {
    // Set display BEFORE measuring so offsetWidth/Height are non-zero.
    if (this.collapsed) { this.pill.setCssStyles({ display: '' }); this.root.setCssStyles({ display: 'none' }); this.updatePillIcon(); this.placePill(); }
    else { this.root.setCssStyles({ display: '' }); this.pill.setCssStyles({ display: 'none' }); this.placeToolbar(); }
  }

  private hide(): void {
    this.root.setCssStyles({ display: 'none' });
    this.pill.setCssStyles({ display: 'none' });
    this.closePopovers();
  }

  private iconButton(icon: IconName, label: string, shortcut?: string): HTMLButtonElement {
    const btn = this.root.createEl('button');
    btn.className = 'blackboard-gt-btn';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', shortcut ? `${label} (${shortcut})` : label);
    setToolbarIcon(btn, icon);
    return btn;
  }

  private separator(): HTMLElement {
    return this.root.createDiv({ cls: 'blackboard-gt-sep' });
  }

  destroy(): void {
    this.endDrag?.();
    this.unsub();
    this.unsubStroke();
    this.unsubStrokeEnd();
    this.win.removeEventListener('resize', this.onResize);
    this.win.removeEventListener('orientationchange', this.onResize);
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    if (this.win.visualViewport) {
      this.win.visualViewport.removeEventListener('resize', this.onResize);
      this.win.visualViewport.removeEventListener('scroll', this.onResize);
    }
    this.root.remove();
    this.pill.remove();
    this.colorPopover.remove();
    this.sizePopover.remove();
  }
}
