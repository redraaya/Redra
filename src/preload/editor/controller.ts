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
import { toggleInlineTag } from './format.js';
import { selectionContext } from './toolbar.js';
import type { ToolbarAction } from './toolbar.js';

/**
 * The editing layer living in the doc preload's isolated world (A1–A4).
 *
 * One controller per loaded document. All listeners sit on `window` in the
 * CAPTURE phase: the preload registers before any page script runs, so they
 * fire ahead of every page handler and can suppress them
 * (stopImmediatePropagation) while editing is on.
 */
export interface EditorController {
  /** Arm (editing) / disarm (Preview) the layer. Idempotent. */
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
    onDuplicate: () => duplicateHoveredBlock(),
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
    onImageReplace: () => {
      const img = overlay.currentImage;
      if (!img || session || dragging) return;
      void replaceImageViaPick(img);
    },
    onToolbar: (action, value) => handleToolbarAction(action, value),
  });

  /** Last selection range shown in the toolbar — restored for link actions
   *  (the link input legitimately steals focus and with it the selection). */
  let lastSelectionRange: Range | null = null;
  let toolbarUpdateQueued = false;

  // --- op transport ---------------------------------------------------------

  async function pushOp(op: Parameters<RedraDocBridge['pushOp']>[0]): Promise<void> {
    const res = await bridge.pushOp(op);
    if (!res.ok) {
      // Main is the source of truth: the journal never recorded this op, so
      // the matching local entry (pushed just before this call) must go too —
      // revert the DOM via its stored inverse and drop it from the stack.
      // The action visibly bounces back; main's localized userMessage (when
      // present — stale-doc rejections stay silent) becomes a shell toast so
      // the bounce is never a mystery.
      console.error('[redra] ops:push rejected:', res.error, op);
      history.undoAndDiscard();
      if (res.userMessage) bridge.notifyRejected(res.userMessage);
    }
  }

  // --- image replacement (v0.2.0) -------------------------------------------

  /** The <img data-redra-id> for an event target, or null. */
  function asReplaceableImage(el: Element): HTMLElement | null {
    return el.tagName === 'IMG' && el.hasAttribute(REDRA_ID_ATTR) ? (el as HTMLElement) : null;
  }

  /**
   * Apply a replacement value to the live img and record it everywhere:
   * local inverse stack first, then ops:push (a rejected push rolls the DOM
   * back via undoAndDiscard — same contract as every other op).
   */
  function applyImageValue(img: HTMLElement, id: string, value: string): void {
    const prevValue = img.getAttribute('src');
    img.setAttribute('src', value);
    history.push({ kind: 'setAttr', el: img, name: 'src', prevValue, newValue: value });
    void pushOp({ type: 'setAttr', id, name: 'src', value });
  }

  async function replaceImageViaPick(img: HTMLElement): Promise<void> {
    const id = img.getAttribute(REDRA_ID_ATTR);
    if (!id) return;
    const res = await bridge.pickImage(id);
    // Errors were already shown by main's dialog; canceled is just canceled.
    if (!res.ok) return;
    applyImageValue(img, id, res.value);
  }

  /** True when the drag carries OS files (not an in-page text/block drag). */
  function isFileDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  }

  function onDragOver(e: DragEvent): void {
    const target = asElement(e.target);
    const img = target && asReplaceableImage(target);
    if (!img || !isFileDrag(e)) return; // not ours — the shell handles .html drops
    e.preventDefault(); // signals "drop allowed here"
    e.stopImmediatePropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDrop(e: DragEvent): void {
    const target = asElement(e.target);
    const img = target && asReplaceableImage(target);
    if (!img) return;
    e.preventDefault(); // never let a file drop on an img navigate the view
    e.stopImmediatePropagation();
    const id = img.getAttribute(REDRA_ID_ATTR);
    const file = e.dataTransfer?.files?.[0];
    if (!id || !file) return;
    let path = '';
    try {
      path = bridge.pathForFile(file);
    } catch {
      return; // synthetic File without a backing fs path
    }
    if (!path) return;
    void bridge.replaceImageFromPath(id, path).then((res) => {
      if (res.ok) applyImageValue(img, id, res.value);
    });
  }

  // --- inline formatting toolbar (Feature 3) ---------------------------------

  /**
   * Recompute the toolbar for the current selection (rAF-throttled via
   * queueToolbarUpdate). Visible only during a session with a non-collapsed
   * selection fully inside the session element.
   */
  function updateToolbar(): void {
    const ctx = session ? selectionContext(win, doc, session.el) : null;
    if (!ctx) {
      lastSelectionRange = null;
      overlay.toolbar.hide();
      return;
    }
    lastSelectionRange = ctx.range.cloneRange();
    overlay.toolbar.show(ctx.rect, ctx.state);
  }

  function queueToolbarUpdate(): void {
    if (toolbarUpdateQueued) return;
    toolbarUpdateQueued = true;
    win.requestAnimationFrame(() => {
      toolbarUpdateQueued = false;
      updateToolbar();
    });
  }

  /** Put the saved selection back into the session element (link flows). */
  function restoreSelection(): void {
    const sel = win.getSelection?.();
    if (!sel || !lastSelectionRange || !session) return;
    session.el.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(lastSelectionRange);
  }

  function handleToolbarAction(action: ToolbarAction, value?: string): void {
    if (!session) return;
    switch (action) {
      case 'bold':
        doc.execCommand?.('bold');
        break;
      case 'italic':
        doc.execCommand?.('italic');
        break;
      case 'code': {
        // execCommand has no "code" — manual Range surgery (see format.ts).
        const sel = win.getSelection?.();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) break;
        const range = sel.getRangeAt(0);
        if (!session.el.contains(range.commonAncestorContainer)) break;
        toggleInlineTag(range, 'code', session.el);
        sel.removeAllRanges();
        sel.addRange(range);
        break;
      }
      case 'link':
        if (!value) break;
        restoreSelection();
        doc.execCommand?.('createLink', false, value);
        break;
      case 'unlink':
        restoreSelection();
        doc.execCommand?.('unlink');
        break;
    }
    queueToolbarUpdate(); // reflect the new state on the buttons
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
    lastSelectionRange = null;
    overlay.toolbar.hide();
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
    overlay.hideImageChip();
  }

  function setHover(block: HTMLElement | null): void {
    if (block === hoverBlock) return;
    clearHover();
    if (!block) return;
    hoverBlock = block;
    block.classList.add('redra-hover');
    overlay.showHandle(block);
  }

  /**
   * Block duplication: unlike other ops the journal push happens in MAIN
   * inside the one 'ops:cloneBlock' invoke (it mints the cloneId), so the
   * DOM changes only AFTER main confirmed — no rollback path needed. The
   * returned fragment is STAMPED (cloneId / cloneId-n), so hover, edit,
   * drag and delete work on the copy immediately.
   */
  function duplicateHoveredBlock(): void {
    const block = overlay.currentBlock;
    if (!block || session || dragging) return;
    const id = block.getAttribute(REDRA_ID_ATTR);
    const parent = block.parentNode as (Node & ParentNode) | null;
    if (!id || !parent) return;
    void bridge.cloneBlock(id).then((res) => {
      if (!res.ok) {
        console.error('[redra] ops:cloneBlock rejected:', res.error);
        if (res.userMessage) bridge.notifyRejected(res.userMessage);
        return;
      }
      // The block may have left the DOM while the invoke was in flight
      // (page script), or the fragment may fail to materialize. Main has
      // ALREADY journaled the op inside the invoke — without a matching
      // LocalHistory entry the journal and the local stack would skew
      // forever (every later ⌘Z would undo the wrong op). The clone op is
      // top-of-journal at this point, so one bridge.undo() rolls it back.
      const undoJournaledClone = (why: string): void => {
        console.warn(`[redra] cloneBlock: ${why} — undoing the journaled op`);
        void bridge.undo().then((r) => {
          if (!r.ok) console.error('[redra] cloneBlock rollback desync: journal had nothing to undo');
        });
      };
      if (!block.isConnected) {
        undoJournaledClone('block left the DOM mid-invoke');
        return;
      }
      block.insertAdjacentHTML('afterend', res.html);
      const inserted = block.nextElementSibling;
      if (!inserted || inserted.getAttribute(REDRA_ID_ATTR) !== res.cloneId) {
        undoJournaledClone('inserted fragment did not materialize as the stamped clone');
        return;
      }
      history.push({ kind: 'cloneBlock', node: inserted, parent, nextSibling: inserted.nextSibling });
    });
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

    // Click on an original <img>: the replace flow, never a text session.
    const img = asReplaceableImage(target);
    if (img) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (session) void endSession(true);
      void replaceImageViaPick(img);
      return;
    }

    // Clicking anywhere else first commits the active session.
    if (session) void endSession(true);

    const editable = resolveEditable(target);
    e.preventDefault();
    e.stopImmediatePropagation();
    if (editable) startSession(editable, e.clientX, e.clientY);
  }

  /** Last known pointer position — lets scroll/resize re-evaluate hover for
   *  whatever ends up under a STATIONARY cursor (mouseover only fires on
   *  boundary crossings, so scrolled-under content never triggers it). */
  let lastPointer: { x: number; y: number } | null = null;

  function onMouseMove(e: MouseEvent): void {
    lastPointer = { x: e.clientX, y: e.clientY };
  }

  function onMouseOver(e: MouseEvent): void {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (session || dragging) return; // block UI is dormant during a session/drag
    const target = asElement(e.target);
    if (!target) return;
    if (overlay.containsTarget(target)) return; // hovering the pill/chip keeps it alive
    applyHoverTarget(target, e.clientX, e.clientY);
  }

  /** Shared hover evaluation for mouseover AND scroll-refresh paths. */
  function applyHoverTarget(target: Element, x: number, y: number): void {
    // Replace affordance for original images: chip at the img's top-right.
    // The chip overlaps the img rect, so there is no dead gap to cross.
    const img = asReplaceableImage(target);
    if (img) overlay.showImageChip(img);
    else overlay.hideImageChip();
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
      withinHandleReach(x, y)
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
    if (!block && hoverBlock && withinHandleReach(x, y)) return;
    setHover(block);
  }

  /** Re-run hover for the element under the stationary pointer (scroll/resize). */
  function refreshHoverUnderPointer(): void {
    if (session || dragging || !lastPointer) return;
    const fromPoint = (doc as { elementFromPoint?: (x: number, y: number) => Element | null })
      .elementFromPoint;
    if (typeof fromPoint !== 'function') return;
    const el = fromPoint.call(doc, lastPointer.x, lastPointer.y);
    if (!el || overlay.containsTarget(el)) return;
    applyHoverTarget(el, lastPointer.x, lastPointer.y);
  }

  function withinHandleReach(x: number, y: number): boolean {
    if (!hoverBlock) return false;
    const r = hoverBlock.getBoundingClientRect();
    const slack = 8;
    return (
      x >= r.left - HANDLE_REACH - slack &&
      x <= r.right + slack &&
      y >= r.top - slack &&
      y <= r.bottom + slack
    );
  }

  function onMouseOut(e: MouseEvent): void {
    // Pointer left the window entirely.
    if (e.relatedTarget === null && !dragging) setHover(null);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Keys typed into overlay chrome (the link input) are the toolbar's own.
    if (overlay.containsTarget(e.target)) return;
    if (e.key !== 'Escape' || !session) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void endSession(false); // Escape REVERTS — no op recorded
  }

  function onFocusOut(e: FocusEvent): void {
    // Focus moving INTO the overlay (link input) must not commit the session.
    if (overlay.containsTarget(e.relatedTarget)) return;
    if (session && e.target === session.el) void endSession(true);
  }

  function queueReposition(): void {
    if (repositionQueued) return;
    repositionQueued = true;
    win.requestAnimationFrame(() => {
      repositionQueued = false;
      overlay.reposition();
      updateToolbar(); // the selection rect moved with the scroll
      // Content may have scrolled under a stationary pointer — mouseover
      // never fires for that, so the chip/handle would go stale (field bug:
      // large images only got the chip when entered from the side).
      refreshHoverUnderPointer();
    });
  }

  const listeners: Array<[string, EventListener, boolean | AddEventListenerOptions]> = [
    ['click', onClick as EventListener, true],
    ['mousemove', onMouseMove as EventListener, { capture: true, passive: true }],
    ['mouseover', onMouseOver as EventListener, true],
    ['mouseout', onMouseOut as EventListener, true],
    ['keydown', onKeyDown as EventListener, true],
    ['focusout', onFocusOut as EventListener, true],
    ['dragover', onDragOver as EventListener, true],
    ['drop', onDrop as EventListener, true],
    // selectionchange targets `document` and does not bubble — the capture
    // phase still passes through `window`, so this fires.
    ['selectionchange', queueToolbarUpdate as EventListener, true],
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
