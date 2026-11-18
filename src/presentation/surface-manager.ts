import type { DrawingSurface } from './drawing-surface';
import type { ConversionTarget } from '../domain/recognition';

/**
 * Tracks the active drawing surface and notifies listeners (one toolbar per Obsidian
 * window) when it changes. Surfaces call setActive() on focus/open and unregister() on
 * close. Each window's toolbar resolves the surface that belongs to its own document,
 * so a popout keeps working while the main window shows a note.
 */
export class SurfaceManager {
  private active: DrawingSurface | null = null;
  private listeners = new Set<(s: DrawingSurface | null, el: HTMLElement | null) => void>();
  private strokeStartListeners = new Set<() => void>();
  private strokeEndListeners = new Set<() => void>();
  private registry = new Map<DrawingSurface, HTMLElement>();
  private conversionTargets = new Map<DrawingSurface, ConversionTarget>();

  /** Register a surface with the DOM element it draws on (for view-based routing). */
  register(surface: DrawingSurface, el: HTMLElement, conversionTarget?: ConversionTarget): void {
    this.registry.set(surface, el);
    if (conversionTarget) this.conversionTargets.set(surface, conversionTarget);
  }

  unregister(surface: DrawingSurface): void {
    this.registry.delete(surface);
    this.conversionTargets.delete(surface);
    this.clearIfActive(surface);
  }

  /**
   * Bind the toolbar to whatever drawing lives in the active view. Keeps the current
   * surface if it's still inside the view (so a focused embed stays active); otherwise
   * picks any registered surface within the view; otherwise hides (null).
   */
  activateForView(viewContainer: HTMLElement | null): void {
    if (!viewContainer) { this.setActive(null); return; }
    if (this.active) {
      const el = this.registry.get(this.active);
      if (el && viewContainer.contains(el)) return;
    }
    for (const [surface, el] of this.registry) {
      if (viewContainer.contains(el)) { this.setActive(surface); return; }
    }
    this.setActive(null);
  }

  setActive(surface: DrawingSurface | null): void {
    if (this.active === surface) return;
    this.active = surface;
    this.notify();
  }

  clearIfActive(surface: DrawingSurface): void {
    if (this.active === surface) {
      this.active = null;
      this.notify();
    }
  }

  getActive(): DrawingSurface | null {
    return this.active;
  }

  /** DOM element of the active surface, or null. */
  getActiveElement(): HTMLElement | null {
    return this.active ? this.registry.get(this.active) ?? null : null;
  }

  getActiveConversionTarget(): ConversionTarget | null {
    return this.active ? this.conversionTargets.get(this.active) ?? null : null;
  }

  /**
   * Content element of the view that is currently in front in `doc`. Obsidian moves the
   * `mod-active` class from the previous leaf to the new one when the active tab group or tab
   * changes, so this is the single authority for "which view is visible". During the transfer
   * two leaves can be marked for a moment; then the one holding DOM focus wins.
   */
  resolveActiveView(doc: Document): HTMLElement | null {
    const views: HTMLElement[] = [];
    for (const leaf of doc.querySelectorAll<HTMLElement>('.workspace-leaf.mod-active')) {
      const content = leaf.querySelector<HTMLElement>('.view-content');
      if (content && !views.includes(content)) views.push(content);
    }
    if (views.length === 0) return null;
    if (views.length === 1) return views[0] ?? null;
    const focused = doc.activeElement;
    if (focused) {
      for (const view of views) {
        if (view === focused || view.contains(focused)) return view;
      }
    }
    return views[views.length - 1] ?? null;
  }

  /**
   * Surface to drive from a given window. Obsidian popouts have their own document, so each
   * window gets its own toolbar. Only a surface inside that window's active view qualifies:
   * a note, Canvas or graph without a drawing must resolve to null even if a hidden drawing
   * tab is still registered. The last-resort fallback exists only for windows that have no
   * workspace DOM yet (early startup, tests).
   */
  surfaceForDocument(doc: Document): { surface: DrawingSurface; el: HTMLElement } | null {
    const activeView = this.resolveActiveView(doc);
    if (activeView) {
      // A view can host several surfaces (embeds, canvas nodes); the focused one keeps control.
      const activeEl = this.active ? this.registry.get(this.active) ?? null : null;
      if (activeEl && activeEl.ownerDocument === doc && activeView.contains(activeEl)) {
        return { surface: this.active as DrawingSurface, el: activeEl };
      }
      for (const [surface, el] of this.registry) {
        if (el.ownerDocument === doc && activeView.contains(el)) return { surface, el };
      }
      return null;
    }
    for (const [surface, el] of this.registry) {
      if (el.ownerDocument === doc) return { surface, el };
    }
    return null;
  }

  /** Conversion target of a specific surface, or null when it is no longer registered. */
  conversionTargetForSurface(surface: DrawingSurface): ConversionTarget | null {
    if (!this.registry.has(surface)) return null;
    return this.conversionTargets.get(surface) ?? null;
  }

  /** Conversion target of the drawing that is actually visible in `doc`, or null. */
  conversionTargetForDocument(doc: Document): ConversionTarget | null {
    const resolved = this.surfaceForDocument(doc);
    return resolved ? this.conversionTargets.get(resolved.surface) ?? null : null;
  }

  /** Re-notify listeners without changing the active surface (e.g. to refresh
   * undo/redo enabled state after an action). */
  refresh(): void {
    this.notify();
  }

  onChange(cb: (s: DrawingSurface | null, el: HTMLElement | null) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Subscribe to "a stroke just began on a surface" so the toolbar can close its
   * popovers when the user starts drawing. */
  onStrokeStart(cb: () => void): () => void {
    this.strokeStartListeners.add(cb);
    return () => { this.strokeStartListeners.delete(cb); };
  }

  /** Called by a surface when the user begins a stroke (pen down to draw/erase). */
  notifyStrokeStart(): void {
    for (const l of this.strokeStartListeners) l();
  }

  /** Subscribe to "a stroke just ended on a surface" so the toolbar can refresh derived
   * state (e.g. undo/redo enablement) the moment a stroke commits, without waiting for an
   * unrelated tool/size/surface change. */
  onStrokeEnd(cb: () => void): () => void {
    this.strokeEndListeners.add(cb);
    return () => { this.strokeEndListeners.delete(cb); };
  }

  /** Called by a surface when the user finishes a stroke (pen up after a draw/erase). */
  notifyStrokeEnd(): void {
    for (const l of this.strokeEndListeners) l();
  }

  private notify(): void {
    const el = this.active ? this.registry.get(this.active) ?? null : null;
    for (const l of this.listeners) l(this.active, el);
  }
}
