import { normalizeEditedHtml } from '../../engine/normalize.js';
import { REDRA_ID_ATTR } from '../../engine/types.js';
import type { RedraDocBridge } from '../../shared/ipc.js';
import { resolveEditable } from './editable.js';
import { resolveBlock } from './blocks.js';
import { beginSession, commitSession, revertSession } from './session.js';
import type { EditSessionState, Normalize } from './session.js';
import { LocalHistory } from './history.js';
import { HANDLE_REACH, Overlay } from './overlay.js';
import { startDrag } from './drag.js';

/**
 * The editing layer living in the doc preload's isolated world (A1–A4).
 *
 * One controller per loaded document. All listeners sit on `window` in the
 * CAPTURE phase: the preload registers before any page script runs, so they
 * fire ahead of every page handler and can suppress them
 * (stopImmediatePropagation) while editing is on.
 */
export interface EditorController {
  /** Arm (editing) / disarm («Просмотр») the layer. Idempotent. */
  setEditing(editing: boolean): void;
  /** Commit any active edit session and push its op. For 'edit:commit'. */
  commitActive(): Promise<void>;
  /** Cmd+Z routed from the menu. */
  handleUndo(): void;
  /** Cmd+Shift+Z routed from the menu. */
  handleRedo(): void;
  destroy(): void;
}

export function createEditorController(
  win: Window,
  bridge: RedraDocBridge,
  normalize: Normalize = normalizeEditedHtml,
): EditorController {
  const doc = win.document;
  const history = new LocalHistory();

  let editing = false;
  let session: EditSessionState | null = null;
  let hoverBlock: HTMLElement | null = null;
  let dragging = false;
  let repositionQueued = false;
  let destroyed = false;

  const overlay = new Overlay(doc, {
    onDelete: () => deleteHoveredBlock(),
    onGripDown: (e) => {
      const block = overlay.currentBlock;
      if (!block || dragging || session) return;
      dragging = true;
      startDrag(block, e, {
        win,
        overlay,
        onDrop: ({ block: moved, beforeEl, beforeId }) => {
          const id = moved.getAttribute(REDRA_ID_ATTR);
          const parent = moved.parentNode as (Node & ParentNode) | null;
          if (!id || !parent) return;
          const oldNext = moved.nextSibling;
          parent.insertBefore(moved, beforeEl);
          history.push({ kind: 'moveBlock', node: moved, parent, oldNext, newNext: moved.nextSibling });
          void pushOp({ type: 'moveBlock', id, beforeId });
        },
        onEnd: () => {
          dragging = false;
          clearHover();
        },
      });
    },
  });

  // --- op transport ---------------------------------------------------------

  async function pushOp(op: Parameters<RedraDocBridge['pushOp']>[0]): Promise<void> {
    const res = await bridge.pushOp(op);
    if (!res.ok) {
      // Main is the source of truth: the journal never recorded this op, so
      // the matching local entry (pushed just before this call) must go too —
      // revert the DOM via its stored inverse and drop it from the stack.
      // User-visible: the action bounces back. Correct v1 behaviour.
      console.error('[redra] ops:push rejected:', res.error, op);
      history.undoAndDiscard();
    }
  }

  // --- edit sessions (A1) ----------------------------------------------------

  function startSession(el: HTMLElement, clickX?: number, clickY?: number): void {
    clearHover();
    const s = beginSession(el, normalize);
    if (!s) return;
    session = s;
    el.focus({ preventScroll: true });
    placeCaret(el, clickX, clickY);
  }

  async function endSession(commit: boolean): Promise<void> {
    const s = session;
    if (!s) return;
    session = null; // cleared first: the blur this triggers must be a no-op
    if (!commit) {
      revertSession(s);
      return;
    }
    const result = commitSession(s, normalize);
    if (!result) return; // unchanged — no op, no history entry
    history.push({
      kind: 'editText',
      el: s.el,
      prevHtml: result.prevHtml,
      newHtml: result.newHtml,
    });
    await pushOp(result.op);
  }

  /**
   * Place the caret at the click point. caretRangeFromPoint is the Chromium
   * API; caretPositionFromPoint is the standard fallback. Neither exists in
   * jsdom — then (and for keyboard-driven entry) the caret goes to the end.
   */
  function placeCaret(el: HTMLElement, x?: number, y?: number): void {
    const sel = win.getSelection?.();
    if (!sel) return;
    let range: Range | null = null;
    type CaretDoc = Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null;
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    };
    const cdoc = doc as CaretDoc;
    if (x !== undefined && y !== undefined) {
      if (typeof cdoc.caretRangeFromPoint === 'function') {
        range = cdoc.caretRangeFromPoint(x, y);
      } else if (typeof cdoc.caretPositionFromPoint === 'function') {
        const pos = cdoc.caretPositionFromPoint(x, y);
        if (pos) {
          range = doc.createRange();
          range.setStart(pos.offsetNode, pos.offset);
        }
      }
      // A point outside the element (padding/margin click) must not put the
      // caret into some other element.
      if (range && !el.contains(range.startContainer)) range = null;
    }
    if (!range) {
      range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // --- block hover + delete (A2) ----------------------------------------------

  /**
   * A block is treated as a page wrapper (no wash, no pill on hover) only
   * when its rect fills BOTH the viewport AND nearly the whole document:
   * a long table is taller than the viewport too, but the document around
   * it is much taller still — it keeps its hover UI. 0.9 instead of 1.0 so
   * wrappers with small top/bottom page margins (padding'ed report bodies,
   * slide frames) are still caught.
   */
  const FULL_PAGE_BLOCK_RATIO = 0.9;

  function isPageWrapper(block: HTMLElement): boolean {
    const height = block.getBoundingClientRect().height;
    return (
      height >= FULL_PAGE_BLOCK_RATIO * win.innerHeight &&
      height >= FULL_PAGE_BLOCK_RATIO * doc.documentElement.scrollHeight
    );
  }

  function clearHover(): void {
    if (hoverBlock) {
      hoverBlock.classList.remove('redra-hover');
      if (hoverBlock.getAttribute('class') === '') hoverBlock.removeAttribute('class');
      hoverBlock = null;
    }
    overlay.hideHandle();
  }

  function setHover(block: HTMLElement | null): void {
    if (block === hoverBlock) return;
    clearHover();
    if (!block) return;
    hoverBlock = block;
    block.classList.add('redra-hover');
    overlay.showHandle(block);
  }

  function deleteHoveredBlock(): void {
    const block = overlay.currentBlock;
    if (!block) return;
    const id = block.getAttribute(REDRA_ID_ATTR);
    const parent = block.parentNode as (Node & ParentNode) | null;
    if (!id || !parent) return;
    clearHover();
    history.push({ kind: 'deleteBlock', node: block, parent, nextSibling: block.nextSibling });
    block.remove();
    void pushOp({ type: 'deleteBlock', id });
  }

  // --- event handlers ----------------------------------------------------------

  /** Cross-realm-safe Element check (no instanceof against a global). */
  function asElement(value: unknown): Element | null {
    return typeof value === 'object' && value !== null && (value as Node).nodeType === 1
      ? (value as Element)
      : null;
  }

  function onClick(e: MouseEvent): void {
    const target = asElement(e.target);
    if (!target) return;
    if (overlay.containsTarget(target)) return; // overlay chrome handles itself

    // Cmd+click on a link: open externally, never edit (design doc).
    if (e.metaKey || e.ctrlKey) {
      const anchor = target.closest('a[href]');
      if (anchor) {
        e.preventDefault();
        e.stopImmediatePropagation();
        bridge.openExternal((anchor as HTMLAnchorElement).href);
        return;
      }
    }

    // Clicks inside the active session: native caret behaviour, but the
    // page's own handlers stay suppressed.
    if (session && session.el.contains(target)) {
      e.stopImmediatePropagation();
      return;
    }

    // Clicking anywhere else first commits the active session.
    if (session) void endSession(true);

    const editable = resolveEditable(target);
    e.preventDefault();
    e.stopImmediatePropagation();
    if (editable) startSession(editable, e.clientX, e.clientY);
  }

  function onMouseOver(e: MouseEvent): void {
    if (session || dragging) return; // block UI is dormant during a session/drag
    const target = asElement(e.target);
    if (!target) return;
    if (overlay.containsTarget(target)) return; // hovering the pill keeps it alive
    let block = resolveBlock(target, win);
    // For a NESTED block the trip to the pill crosses its PARENT container,
    // which resolves as a block of its own — without this guard the pill
    // jumps to the parent before it can be clicked. Keep the current block
    // while the pointer is over one of its ancestors AND still within reach
    // of the pill.
    if (
      block &&
      hoverBlock &&
      block !== hoverBlock &&
      block.contains(hoverBlock) &&
      withinHandleReach(e)
    ) {
      return;
    }
    // Page-wrapper noise: a top-level wrapper that fills the viewport AND
    // the document would highlight the whole page as one "block" — useless
    // wash, useless pill. Suppress the hover UI for it (resolveBlock stays
    // pure; nested content inside still resolves to its own block on its
    // own mouseover).
    if (block && isPageWrapper(block)) {
      block = null;
    }
    // The pill floats LEFT of the block, so the pointer crosses "no man's
    // land" on its way there — mouseover fires on the page background where
    // no block resolves, and without this guard the pill vanishes before it
    // can be clicked. Keep the current block while the pointer stays inside
    // its rect extended to cover the pill (plus diagonal slack).
    if (!block && hoverBlock && withinHandleReach(e)) return;
    setHover(block);
  }

  function withinHandleReach(e: MouseEvent): boolean {
    if (!hoverBlock) return false;
    const r = hoverBlock.getBoundingClientRect();
    const slack = 8;
    return (
      e.clientX >= r.left - HANDLE_REACH - slack &&
      e.clientX <= r.right + slack &&
      e.clientY >= r.top - slack &&
      e.clientY <= r.bottom + slack
    );
  }

  function onMouseOut(e: MouseEvent): void {
    // Pointer left the window entirely.
    if (e.relatedTarget === null && !dragging) setHover(null);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !session) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void endSession(false); // Escape REVERTS — no op recorded
  }

  function onFocusOut(e: FocusEvent): void {
    if (session && e.target === session.el) void endSession(true);
  }

  function queueReposition(): void {
    if (repositionQueued) return;
    repositionQueued = true;
    win.requestAnimationFrame(() => {
      repositionQueued = false;
      overlay.reposition();
    });
  }

  const listeners: Array<[string, EventListener, boolean | AddEventListenerOptions]> = [
    ['click', onClick as EventListener, true],
    ['mouseover', onMouseOver as EventListener, true],
    ['mouseout', onMouseOut as EventListener, true],
    ['keydown', onKeyDown as EventListener, true],
    ['focusout', onFocusOut as EventListener, true],
    ['scroll', queueReposition as EventListener, { capture: true, passive: true }],
    ['resize', queueReposition as EventListener, true],
  ];

  function arm(): void {
    for (const [type, fn, opts] of listeners) win.addEventListener(type, fn, opts);
  }

  function disarm(): void {
    for (const [type, fn, opts] of listeners) {
      const capture = typeof opts === 'boolean' ? opts : (opts.capture ?? false);
      win.removeEventListener(type, fn, capture);
    }
  }

  return {
    setEditing(next: boolean): void {
      if (destroyed || next === editing) return;
      editing = next;
      if (editing) {
        arm();
      } else {
        // Main commits the session before flipping the mode; this is the
        // belt-and-braces path for a commit that raced or timed out.
        void endSession(true);
        clearHover();
        disarm();
      }
    },
    commitActive(): Promise<void> {
      return endSession(true);
    },
    handleUndo(): void {
      if (session) {
        // Native contenteditable undo within the session.
        doc.execCommand?.('undo');
        return;
      }
      if (!history.canUndo) return;
      history.undo();
      void bridge.undo().then((res) => {
        if (!res.ok) console.error('[redra] undo desync: journal had nothing to undo');
      });
    },
    handleRedo(): void {
      if (session) {
        doc.execCommand?.('redo');
        return;
      }
      if (!history.canRedo) return;
      history.redo();
      void bridge.redo().then((res) => {
        if (!res.ok) console.error('[redra] redo desync: journal had nothing to redo');
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (editing) disarm();
      editing = false;
      session = null;
      clearHover();
      overlay.destroy();
    },
  };
}
