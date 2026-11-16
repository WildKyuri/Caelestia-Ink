import type { Stroke } from './entities';

export interface Command {
  execute(): void;
  undo(): void;
}

export class StrokeManager {
  strokes: Stroke[] = [];
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  addStroke(stroke: Stroke): void {
    this.strokes.push(stroke);
    this.undoStack.push({
      execute: () => { this.strokes.push(stroke); },
      undo: () => { const i = this.strokes.findIndex(s => s.id === stroke.id); if (i !== -1) this.strokes.splice(i, 1); },
    });
    this.redoStack.length = 0;
  }

  deleteStroke(id: string): void {
    const index = this.strokes.findIndex(s => s.id === id);
    if (index === -1) return;
    const deleted = this.strokes.splice(index, 1)[0];
    this.undoStack.push({
      execute: () => { const i = this.strokes.findIndex(s => s.id === deleted.id); if (i !== -1) this.strokes.splice(i, 1); },
      undo: () => { this.strokes.splice(index, 0, deleted); },
    });
    this.redoStack.length = 0;
  }

  moveStroke(id: string, dx: number, dy: number): void {
    const stroke = this.strokes.find(s => s.id === id);
    if (!stroke) return;
    for (const point of stroke.points) {
      point[0] += dx;
      point[1] += dy;
    }
    this.undoStack.push({
      execute: () => {
        const s = this.strokes.find(x => x.id === id);
        if (s) for (const p of s.points) { p[0] += dx; p[1] += dy; }
      },
      undo: () => {
        const s = this.strokes.find(x => x.id === id);
        if (s) for (const p of s.points) { p[0] -= dx; p[1] -= dy; }
      },
    });
    this.redoStack.length = 0;
  }

  /**
   * Swap the stroke list without touching history. Used during a live eraser drag, where
   * every pointer move rewrites the list and only the whole drag should become one undo
   * step (see `commitReplace`).
   */
  setStrokes(next: Stroke[]): void {
    this.strokes = next;
  }

  /**
   * Record one undoable step from a pre-drag snapshot to the current stroke list. Returns
   * false (and records nothing) when the drag changed nothing. Snapshots are copied, so a
   * later stroke added to the live list cannot leak into history.
   */
  commitReplace(before: Stroke[]): boolean {
    const after = this.strokes.slice();
    if (before.length === after.length && before.every((s, i) => s === after[i])) return false;
    this.strokes = after;
    this.undoStack.push({
      execute: () => { this.strokes = after; },
      undo: () => { this.strokes = before; },
    });
    this.redoStack.length = 0;
    return true;
  }

  clearAll(): void {
    const saved = this.strokes;
    this.strokes = [];
    this.undoStack.push({
      execute: () => { this.strokes = []; },
      undo: () => { this.strokes = saved; },
    });
    this.redoStack.length = 0;
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.execute();
    this.undoStack.push(cmd);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  reset(): void {
    this.strokes.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
