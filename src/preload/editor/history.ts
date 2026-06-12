/**
 * Local inverse stack mirroring the main-process journal (A4).
 *
 * The journal in main knows WHAT changed (ops); only this side knows how to
 * undo it in the LIVE DOM (it holds the real nodes). Both stacks are linear
 * and ops only originate here, so they stay in lockstep: every push here is
 * an ops:push there, every undo/redo here is an ops:undo/ops:redo there.
 */
export type HistoryEntry =
  | { kind: 'editText'; el: HTMLElement; prevHtml: string; newHtml: string }
  | { kind: 'deleteBlock'; node: Element; parent: Node & ParentNode; nextSibling: Node | null }
  /** The INSERTED clone (undo = remove it, redo = re-insert before nextSibling). */
  | { kind: 'cloneBlock'; node: Element; parent: Node & ParentNode; nextSibling: Node | null }
  | {
      kind: 'setAttr';
      el: Element;
      name: string;
      /** Attribute value before the change; null = the attribute was absent. */
      prevValue: string | null;
      newValue: string;
    }
  | {
      kind: 'moveBlock';
      node: Element;
      parent: Node & ParentNode;
      /** node.nextSibling before the move (any node — keeps whitespace stable). */
      oldNext: Node | null;
      /** node.nextSibling after the move, for redo. */
      newNext: Node | null;
    };

export class LocalHistory {
  private entries: HistoryEntry[] = [];
  private cursor = 0;

  push(entry: HistoryEntry): void {
    this.entries.length = this.cursor;
    this.entries.push(entry);
    this.cursor++;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  /** Revert the latest entry in the live DOM. False when there is none. */
  undo(): boolean {
    if (!this.canUndo) return false;
    const entry = this.entries[--this.cursor]!;
    switch (entry.kind) {
      case 'editText':
        entry.el.innerHTML = entry.prevHtml;
        break;
      case 'deleteBlock':
        entry.parent.insertBefore(entry.node, entry.nextSibling);
        break;
      case 'cloneBlock':
        entry.node.remove();
        break;
      case 'moveBlock':
        entry.parent.insertBefore(entry.node, entry.oldNext);
        break;
      case 'setAttr':
        if (entry.prevValue === null) entry.el.removeAttribute(entry.name);
        else entry.el.setAttribute(entry.name, entry.prevValue);
        break;
    }
    return true;
  }

  /**
   * Roll back the LATEST entry after main REJECTED its ops:push: revert it
   * in the live DOM and remove it from the stack entirely (it must not be
   * redoable), so the local stack stays in lockstep with the journal that
   * never recorded the op. Entries are pushed before the push resolves, so
   * the rejected op is always the newest entry.
   */
  undoAndDiscard(): void {
    if (!this.canUndo) return;
    this.undo();
    this.entries.length = this.cursor; // drop the entry — no redo tail
  }

  /** Re-apply the next entry in the live DOM. False when there is none. */
  redo(): boolean {
    if (!this.canRedo) return false;
    const entry = this.entries[this.cursor++]!;
    switch (entry.kind) {
      case 'editText':
        entry.el.innerHTML = entry.newHtml;
        break;
      case 'deleteBlock':
        entry.node.remove();
        break;
      case 'cloneBlock':
        entry.parent.insertBefore(entry.node, entry.nextSibling);
        break;
      case 'moveBlock':
        entry.parent.insertBefore(entry.node, entry.newNext);
        break;
      case 'setAttr':
        entry.el.setAttribute(entry.name, entry.newValue);
        break;
    }
    return true;
  }
}
