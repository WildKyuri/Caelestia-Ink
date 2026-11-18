import { vi } from 'vitest';

// Polyfill ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// Obsidian's cross-window instanceof (Node.instanceOf): true when the node is an instance of the
// class of that name in its OWN window, which is what makes popout-window elements pass.
// Obsidian installs it in every window it opens (popouts included); tests call this for extra windows.
export function installInstanceOf(win: { Node: typeof Node }): void {
  if ((win.Node.prototype as any).instanceOf) return;
  (win.Node.prototype as any).instanceOf = function (this: Node, type: { new (...a: any[]): unknown; name: string }) {
    if (this instanceof type) return true;
    const own = this.ownerDocument?.defaultView as any;
    return !!own && typeof own[type.name] === 'function' && this instanceof own[type.name];
  };
}
installInstanceOf(globalThis as any);

/** Install the HTMLElement helpers Obsidian exposes in every main or popout window. */
export function installObsidianDom(win: { HTMLElement: typeof HTMLElement; document: Document }): void {
  const proto = win.HTMLElement.prototype;
  if (!proto.empty) {
    proto.empty = function () {
      this.innerHTML = '';
    };
  }

  if (!proto.addClass) {
    (proto as any).addClass = function (cls: string) {
      this.classList.add(cls);
    };
  }

  if (!proto.removeClass) {
    (proto as any).removeClass = function (cls: string) {
      this.classList.remove(cls);
    };
  }

  if (!proto.toggleClass) {
    (proto as any).toggleClass = function (cls: string, value: boolean) {
      this.classList.toggle(cls, value);
    };
  }

  if (!proto.hasClass) {
    (proto as any).hasClass = function (cls: string) {
      return this.classList.contains(cls);
    };
  }

  if (!proto.createDiv) {
    (proto as any).createDiv = function (opts?: Record<string, unknown>) {
      const div = win.document.createElement('div');
      if (opts) {
        const { cls, text, ...rest } = opts as { cls?: string; text?: string };
        if (cls) div.className = cls;
        if (text) div.textContent = text;
        Object.assign(div, rest);
      }
      this.appendChild(div);
      return div;
    };
  }

  if (!proto.createEl) {
    (proto as any).createEl = function (tag: string, opts?: Record<string, unknown>) {
      const el = win.document.createElement(tag);
      // Obsidian assigns every extra key onto the element (value, type, href, ...).
      if (opts) {
        const { cls, text, ...rest } = opts as { cls?: string; text?: string };
        if (cls) el.className = cls;
        if (text) el.textContent = text;
        Object.assign(el, rest);
      }
      this.appendChild(el);
      return el;
    };
  }

  // jsdom lacks Obsidian's setCssStyles; mirror its behavior (assign onto inline style).
  if (!proto.setCssStyles) {
    (proto as any).setCssStyles = function (styles: Partial<CSSStyleDeclaration>) {
      Object.assign(this.style, styles);
    };
  }

  if (!proto.createSpan) {
    (proto as any).createSpan = function (opts?: { cls?: string; text?: string }) {
      return this.createEl('span', opts);
    };
  }
}
installObsidianDom(globalThis as any);

if (typeof globalThis.URL.createObjectURL !== 'function') {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
}

if (typeof globalThis.URL.revokeObjectURL !== 'function') {
  globalThis.URL.revokeObjectURL = vi.fn();
}

// Obsidian runtime globals (obsidian.d.ts declares them; the app provides them).
// activeDocument/activeWindow alias the focused window (in jsdom there is only one window).
(globalThis as any).activeDocument = document;
(globalThis as any).activeWindow = window;
if (typeof (globalThis as any).createEl !== 'function') {
  (globalThis as any).createEl = (tag: string, o?: { cls?: string; text?: string }) => {
    const el = document.createElement(tag);
    if (o?.cls) el.className = o.cls;
    if (o?.text) el.textContent = o.text;
    return el;
  };
}
if (typeof (globalThis as any).createDiv !== 'function') {
  (globalThis as any).createDiv = (o?: { cls?: string; text?: string }) =>
    (globalThis as any).createEl('div', o);
}
