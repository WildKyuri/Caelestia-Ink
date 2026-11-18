import { describe, it, expect, vi, afterEach } from 'vitest';
import { SurfaceManager } from '../src/presentation/surface-manager';
import type { DrawingSurface } from '../src/presentation/drawing-surface';

/**
 * The manager only stores and compares surface identities; it never invokes any
 * DrawingSurface method during routing/notification. So a plain object cast to
 * the interface is a sufficient fake for these unit tests.
 */
function fakeSurface(label: string): DrawingSurface {
  return { __label: label } as unknown as DrawingSurface;
}

// Routing now reads the focused view from the document, so a leaf left behind by one test
// would become a stale candidate for the next one.
afterEach(() => {
  document.querySelectorAll('.workspace-leaf').forEach((leaf) => leaf.remove());
  document.querySelectorAll('iframe').forEach((frame) => frame.remove());
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('SurfaceManager', () => {
  it('returns the conversion target registered for the active surface only', () => {
    const mgr = new SurfaceManager();
    const surface = fakeSurface('convertible');
    const target = {
      getSourcePath: () => 'Blackboard/test.blackboard',
      getFile: vi.fn(),
    };
    mgr.register(surface, document.createElement('div'), target as any);

    expect(mgr.getActiveConversionTarget()).toBeNull();
    mgr.setActive(surface);
    expect(mgr.getActiveConversionTarget()).toBe(target);
    mgr.unregister(surface);
    expect(mgr.getActiveConversionTarget()).toBeNull();
  });

  it('register + activateForView routes to that surface', () => {
    const mgr = new SurfaceManager();
    const surface = fakeSurface('a');
    const view = document.createElement('div');
    const el = document.createElement('div');
    view.appendChild(el);

    mgr.register(surface, el);
    mgr.activateForView(view);

    expect(mgr.getActive()).toBe(surface);
  });

  it('setActive(b) while a is active switches active and notifies with (b, elB)', () => {
    const mgr = new SurfaceManager();
    const a = fakeSurface('a');
    const b = fakeSurface('b');
    const elA = document.createElement('div');
    const elB = document.createElement('div');
    mgr.register(a, elA);
    mgr.register(b, elB);

    mgr.setActive(a);

    const listener = vi.fn();
    mgr.onChange(listener);

    mgr.setActive(b);

    expect(mgr.getActive()).toBe(b);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(b, elB);
  });

  it('setActive(s) when s is already active does not notify again', () => {
    const mgr = new SurfaceManager();
    const s = fakeSurface('s');
    const el = document.createElement('div');
    mgr.register(s, el);

    mgr.setActive(s);

    const listener = vi.fn();
    mgr.onChange(listener);

    mgr.setActive(s);

    expect(mgr.getActive()).toBe(s);
    expect(listener).not.toHaveBeenCalled();
  });

  it('setActive(null) clears active and notifies with (null, null)', () => {
    const mgr = new SurfaceManager();
    const s = fakeSurface('s');
    const el = document.createElement('div');
    mgr.register(s, el);
    mgr.setActive(s);

    const listener = vi.fn();
    mgr.onChange(listener);

    mgr.setActive(null);

    expect(mgr.getActive()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null, null);
  });

  it('unregister(activeSurface) clears active and notifies', () => {
    const mgr = new SurfaceManager();
    const s = fakeSurface('s');
    const el = document.createElement('div');
    mgr.register(s, el);
    mgr.setActive(s);

    const listener = vi.fn();
    mgr.onChange(listener);

    mgr.unregister(s);

    expect(mgr.getActive()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    // After unregister the element is no longer known, so it notifies with null.
    expect(listener).toHaveBeenCalledWith(null, null);
  });

  it('onChange returns an unsubscribe fn that stops future notifications', () => {
    const mgr = new SurfaceManager();
    const a = fakeSurface('a');
    const b = fakeSurface('b');
    mgr.register(a, document.createElement('div'));
    mgr.register(b, document.createElement('div'));

    const listener = vi.fn();
    const unsubscribe = mgr.onChange(listener);

    mgr.setActive(a);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    mgr.setActive(b);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('refresh() re-notifies listeners with the unchanged active surface/element', () => {
    const mgr = new SurfaceManager();
    const s = fakeSurface('s');
    const el = document.createElement('div');
    mgr.register(s, el);
    mgr.setActive(s);

    const listener = vi.fn();
    mgr.onChange(listener);

    mgr.refresh();

    expect(mgr.getActive()).toBe(s);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(s, el);
  });

  it('activateForView(null) clears active to null', () => {
    const mgr = new SurfaceManager();
    const s = fakeSurface('s');
    const el = document.createElement('div');
    mgr.register(s, el);
    mgr.setActive(s);

    mgr.activateForView(null);

    expect(mgr.getActive()).toBeNull();
  });

  describe('activateForView routing with real DOM containment', () => {
    it('keeps the current active surface if its element is contained in the view', () => {
      const mgr = new SurfaceManager();
      const a = fakeSurface('a');
      const b = fakeSurface('b');
      const view = document.createElement('div');
      const elA = document.createElement('div');
      const elB = document.createElement('div');
      view.appendChild(elA);
      view.appendChild(elB);
      mgr.register(a, elA);
      mgr.register(b, elB);

      mgr.setActive(a);

      const listener = vi.fn();
      mgr.onChange(listener);

      mgr.activateForView(view);

      // a stays active (its element is inside view); no switch, no notify.
      expect(mgr.getActive()).toBe(a);
      expect(listener).not.toHaveBeenCalled();
    });

    it('falls back to a registered surface inside the view when the active one is not', () => {
      const mgr = new SurfaceManager();
      const a = fakeSurface('a');
      const b = fakeSurface('b');
      const elsewhere = document.createElement('div');
      const elA = document.createElement('div');
      elsewhere.appendChild(elA); // a's element lives outside the target view
      const view = document.createElement('div');
      const elB = document.createElement('div');
      view.appendChild(elB);
      mgr.register(a, elA);
      mgr.register(b, elB);

      mgr.setActive(a);
      mgr.activateForView(view);

      expect(mgr.getActive()).toBe(b);
    });

    it('clears to null when no registered surface element is inside the view', () => {
      const mgr = new SurfaceManager();
      const a = fakeSurface('a');
      const elsewhere = document.createElement('div');
      const elA = document.createElement('div');
      elsewhere.appendChild(elA);
      mgr.register(a, elA);

      mgr.setActive(a);

      const emptyView = document.createElement('div');
      mgr.activateForView(emptyView);

      expect(mgr.getActive()).toBeNull();
    });
  });

  describe('surfaceForDocument (per-window toolbars)', () => {
    function activeViewIn(doc: Document): HTMLElement {
      const leaf = doc.createElement('div');
      leaf.className = 'workspace-leaf mod-active';
      const view = doc.createElement('div');
      view.className = 'view-content';
      leaf.appendChild(view);
      doc.body.appendChild(leaf);
      return view;
    }

    it('returns the surface inside the given window active view, not another window', () => {
      const mgr = new SurfaceManager();
      const main = fakeSurface('main');
      const pop = fakeSurface('pop');
      const mainView = activeViewIn(document);
      const mainEl = document.createElement('div');
      mainView.appendChild(mainEl);
      mgr.register(main, mainEl);

      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument!;
      const popView = activeViewIn(doc);
      const popEl = doc.createElement('div');
      popView.appendChild(popEl);
      mgr.register(pop, popEl);

      expect(mgr.surfaceForDocument(document)?.surface).toBe(main);
      expect(mgr.surfaceForDocument(doc)?.surface).toBe(pop);

      iframe.remove();
    });

    it('returns null when the window active view holds no drawing', () => {
      const mgr = new SurfaceManager();
      const s = fakeSurface('s');
      const el = document.createElement('div');
      document.body.appendChild(el);
      mgr.register(s, el);

      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument!;
      activeViewIn(doc); // active view with no registered surface inside

      expect(mgr.surfaceForDocument(doc)).toBeNull();

      iframe.remove();
      el.remove();
    });

    it('ignores a drawing tab that is still registered but no longer the active view', () => {
      const mgr = new SurfaceManager();
      const drawing = fakeSurface('drawing');
      const drawingLeaf = document.createElement('div');
      drawingLeaf.className = 'workspace-leaf mod-active';
      const drawingView = document.createElement('div');
      drawingView.className = 'view-content';
      const drawingEl = document.createElement('div');
      drawingView.appendChild(drawingEl);
      drawingLeaf.appendChild(drawingView);
      document.body.appendChild(drawingLeaf);
      mgr.register(drawing, drawingEl);
      mgr.setActive(drawing);

      // Obsidian moves mod-active to the note leaf; the drawing tab stays alive behind it.
      drawingLeaf.classList.remove('mod-active');
      const noteLeaf = document.createElement('div');
      noteLeaf.className = 'workspace-leaf mod-active';
      const noteView = document.createElement('div');
      noteView.className = 'view-content';
      noteLeaf.appendChild(noteView);
      document.body.appendChild(noteLeaf);

      expect(mgr.resolveActiveView(document)).toBe(noteView);
      expect(mgr.surfaceForDocument(document)).toBeNull();

      // Returning to the drawing tab restores it.
      noteLeaf.remove();
      drawingLeaf.classList.add('mod-active');
      expect(mgr.surfaceForDocument(document)?.surface).toBe(drawing);
      expect(mgr.resolveActiveView(document)).toBe(drawingView);

      drawingLeaf.remove();
    });

    it('keeps the focused surface when one view hosts several (embeds)', () => {
      const mgr = new SurfaceManager();
      const first = fakeSurface('first');
      const second = fakeSurface('second');
      const view = activeViewIn(document);
      const firstEl = document.createElement('div');
      const secondEl = document.createElement('div');
      view.appendChild(firstEl);
      view.appendChild(secondEl);
      mgr.register(first, firstEl);
      mgr.register(second, secondEl);

      expect(mgr.surfaceForDocument(document)?.surface).toBe(first);
      mgr.setActive(second);
      expect(mgr.surfaceForDocument(document)?.surface).toBe(second);

      view.parentElement?.remove();
    });

    it('prefers the leaf holding focus while two leaves are marked active', () => {
      const mgr = new SurfaceManager();
      const drawing = fakeSurface('drawing');
      const drawingView = activeViewIn(document);
      const drawingEl = document.createElement('div');
      drawingView.appendChild(drawingEl);
      mgr.register(drawing, drawingEl);

      const noteEl = activeViewIn(document);
      const focused = noteEl.createDiv();
      (focused as HTMLElement).setAttribute('tabindex', '0');
      focused.focus();

      expect(mgr.resolveActiveView(document)).toBe(noteEl);
      expect(mgr.surfaceForDocument(document)).toBeNull();

      drawingView.parentElement?.remove();
      noteEl.parentElement?.remove();
    });
  });

  describe('conversion targets follow the visible surface', () => {
    it('resolves the target of the drawing in the active view only', () => {
      const mgr = new SurfaceManager();
      const drawing = fakeSurface('drawing');
      const noteDrawing = fakeSurface('note-drawing');
      const drawingTarget = { getSourcePath: () => 'Board/visible.blackboard' };
      const noteTarget = { getSourcePath: () => 'Board/hidden.blackboard' };

      const drawingView = document.createElement('div');
      const drawingLeaf = document.createElement('div');
      drawingLeaf.className = 'workspace-leaf mod-active';
      drawingView.className = 'view-content';
      drawingLeaf.appendChild(drawingView);
      document.body.appendChild(drawingLeaf);
      const drawingEl = document.createElement('div');
      drawingView.appendChild(drawingEl);
      mgr.register(drawing, drawingEl, drawingTarget as never);

      // A note in another tab that also holds an embed with its own drawing.
      const noteLeaf = document.createElement('div');
      noteLeaf.className = 'workspace-leaf';
      const noteView = document.createElement('div');
      noteView.className = 'view-content';
      noteLeaf.appendChild(noteView);
      document.body.appendChild(noteLeaf);
      const noteDrawingEl = document.createElement('div');
      noteView.appendChild(noteDrawingEl);
      mgr.register(noteDrawing, noteDrawingEl, noteTarget as never);

      expect(mgr.conversionTargetForDocument(document)?.getSourcePath()).toBe('Board/visible.blackboard');
      expect(mgr.conversionTargetForSurface(drawing)?.getSourcePath()).toBe('Board/visible.blackboard');
      expect(mgr.conversionTargetForSurface(noteDrawing)?.getSourcePath()).toBe('Board/hidden.blackboard');

      mgr.unregister(noteDrawing);
      expect(mgr.conversionTargetForSurface(noteDrawing)).toBeNull();

      drawingLeaf.remove();
      noteLeaf.remove();
    });
  });

  describe('stroke-end notification (the undo arrow lights up after the first stroke)', () => {
    it('notifyStrokeEnd calls every onStrokeEnd listener', () => {
      const mgr = new SurfaceManager();
      const cb = vi.fn();
      mgr.onStrokeEnd(cb);

      mgr.notifyStrokeEnd();

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('onStrokeEnd returns an unsubscribe that stops further notifications', () => {
      const mgr = new SurfaceManager();
      const cb = vi.fn();
      const unsub = mgr.onStrokeEnd(cb);

      unsub();
      mgr.notifyStrokeEnd();

      expect(cb).not.toHaveBeenCalled();
    });
  });
});
