import type { Op } from './ops.js';

/**
 * Linear undo/redo journal of edit operations.
 *
 * The journal never mutates a document — it only tracks which ops are
 * "active" (those up to the cursor). Callers pass `journal.ops` to
 * serializeSource on save.
 */
export class Journal {
  private all: Op[] = [];
  private cursor = 0;
  private saved: readonly Op[] = [];

  /** Append an op at the cursor, discarding any redo tail. */
  push(op: Op): void {
    this.all.length = this.cursor;
    this.all.push(op);
    this.cursor++;
  }

  /** Step the cursor back one op. Returns false if there is nothing to undo. */
  undo(): boolean {
    if (!this.canUndo) return false;
    this.cursor--;
    return true;
  }

  /** Step the cursor forward one op. Returns false if there is nothing to redo. */
  redo(): boolean {
    if (!this.canRedo) return false;
    this.cursor++;
    return true;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.all.length;
  }

  /** The active ops: everything up to the cursor. */
  get ops(): readonly Op[] {
    return this.all.slice(0, this.cursor);
  }

  /** True when the active ops differ from those captured by the last markSaved(). */
  get dirty(): boolean {
    if (this.saved.length !== this.cursor) return true;
    for (let i = 0; i < this.cursor; i++) {
      if (this.saved[i] !== this.all[i]) return true;
    }
    return false;
  }

  /** Capture the current active ops as the saved state. */
  markSaved(): void {
    this.saved = this.ops;
  }
}
