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
    }
  /** Block-type change: the old element was replaced in place by the new one. */
  | { kind: 'replaceBlock'; oldNode: Element; newNode: Element };

/** Apply an entry's DOM INVERSE (the undo direction). Shared by undo() and
 *  discardEntry() so a rejected push reverts exactly like a normal undo. */
function invertEntry(entry: HistoryEntry): void {
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
    case 'replaceBlock':
      entry.newNode.replaceWith(entry.oldNode); // undo = restore the old block
      break;
  }
}

export class LocalHistory {
  private entries: HistoryEntry[] = [];
  private cursor = 0;

  /** Returns the pushed entry so a caller can later discard THAT exact entry by
   *  identity if its async ops:push is rejected (it may not be the top by then). */
  push(entry: HistoryEntry): HistoryEntry {
    this.entries.length = this.cursor;
    this.entries.push(entry);
    this.cursor++;
    return entry;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  /** The entry a redo() would re-apply next, or null at the tip. Lets the
   *  controller tell a redo of THIS session's own checkpoint apart from a stale
   *  redo tail left by a PRIOR block (cross-block redo guard). */
  get nextRedo(): HistoryEntry | null {
    return this.canRedo ? this.entries[this.cursor]! : null;
  }

  /** Revert the latest entry in the live DOM. False when there is none. */
  undo(): boolean {
    if (!this.canUndo) return false;
    invertEntry(this.entries[--this.cursor]!);
    return true;
  }

  /**
   * Roll back the LATEST entry (synchronous callers only — the session-revert
   * loop in endSession(false), where the just-pushed checkpoints ARE the top of
   * the stack and no async push can have interleaved). Reverts it in the DOM and
   * drops it so it leaves no redo tail.
   */
  undoAndDiscard(): void {
    if (!this.canUndo) return;
    this.undo();
    this.entries.length = this.cursor; // drop the entry — no redo tail
  }

  /**
   * Roll back a SPECIFIC entry by identity after its async ops:push was rejected.
   * Under the FIFO transport the rejected push's entry may NOT be the newest
   * anymore (a later sync push, or a mid-session undo, moved it), so popping the
   * top would corrupt the stack. Reverts the DOM only when it is safe: an entry
   * already past the cursor was undone mid-session (not applied — never revert);
   * and a same-block editText that is no longer the newest applied entry is part
   * of a checkpoint CHAIN, so reverting it to its prevHtml would wipe the later
   * edits (skip — this only happens on stale-doc, where the view is replaced).
   * Other op kinds (and a newest editText, e.g. a child block edited after its
   * parent and rejected blocked-subtree) touch independent state and revert
   * cleanly so the action visibly bounces.
   */
  discardEntry(entry: HistoryEntry): void {
    const i = this.entries.indexOf(entry);
    if (i < 0) return;
    const applied = i < this.cursor;
    if (applied && (entry.kind !== 'editText' || i === this.cursor - 1)) invertEntry(entry);
    this.entries.splice(i, 1);
    if (applied) this.cursor--;
  }

  /** Re-apply the next entry in the live DOM. False when there is none.
   *  (Mirror of invertEntry; kept inline as it advances the cursor.) */
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
      case 'replaceBlock':
        entry.oldNode.replaceWith(entry.newNode); // redo = re-apply the new block
        break;
    }
    return true;
  }
}
