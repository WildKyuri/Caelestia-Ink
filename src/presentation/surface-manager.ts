import type { DrawingSurface } from './drawing-surface';

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

  /** Register a surface with the DOM element it draws on (for view-based routing). */
  register(surface: DrawingSurface, el: HTMLElement): void {
    this.registry.set(surface, el);
  }

  unregister(surface: DrawingSurface): void {
    this.registry.delete(surface);
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

  /**
   * Surface to drive from a given window. Obsidian popouts have their own document, so each
   * window gets its own toolbar. Prefer a surface inside that window's active view (so a note
   * or Canvas without a drawing shows no toolbar); fall back to any registered surface only
   * when the window has no active view at all (tests, early startup).
   */
  surfaceForDocument(doc: Document): { surface: DrawingSurface; el: HTMLElement } | null {
    const activeView = doc.querySelector<HTMLElement>('.workspace-leaf.mod-active .view-content');
    let fallback: { surface: DrawingSurface; el: HTMLElement } | null = null;
    for (const [surface, el] of this.registry) {
      if (el.ownerDocument !== doc) continue;
      if (activeView) {
        if (activeView.contains(el)) return { surface, el };
        continue;
      }
      if (!fallback) fallback = { surface, el };
    }
    return fallback;
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
