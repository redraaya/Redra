import {
  normalizeEditedHtml,
  HEAVY_STAMPED_ATTR_LIMIT,
  stubHeavyStampedAttrs,
} from '../../engine/normalize.js';
import { REDRA_ID_ATTR } from '../../engine/types.js';
import type { RedraDocBridge } from '../../shared/ipc.js';
import type { DocFormat, BlockKind } from '../../shared/doc-types.js';
import { resolveEditable } from './editable.js';
import { resolveBlock } from './blocks.js';
import { beginSession, revertSession, endVisuals, isUndoGroupBoundary } from './session.js';
import type { EditSessionState, Normalize } from './session.js';
import { LocalHistory } from './history.js';
import type { HistoryEntry } from './history.js';
import { HANDLE_REACH, Overlay } from './overlay.js';
import { startDrag } from './drag.js';
import { computeInlineToggle, toggleInlineTag } from './format.js';
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
  /** Change the target block's type (Markdown "Turn into …"). No-op for HTML. */
  turnInto(kind: BlockKind): void;
  /** Toggle an inline format over the current selection (Format-menu shortcut,
   *  e.g. ⌘B). Same pipeline as a toolbar click; no-ops without a live session. */
  applyFormat(action: ToolbarAction): void;
  /** Show the titlebar tooltip over the document (the shell drives hover; the
   *  doc view draws it so it clears this view, which composites over the shell
   *  strip). x,y are in this view's coordinates. */
  showTip(text: string, x: number, y: number): void;
  hideTip(): void;
  destroy(): void;
}

export function createEditorController(
  win: Window,
  bridge: RedraDocBridge,
  normalize: Normalize = normalizeEditedHtml,
  format: DocFormat = 'html',
): EditorController {
  const doc = win.document;
  const history = new LocalHistory();

  let editing = false;
  let session: EditSessionState | null = null;
  let hoverBlock: HTMLElement | null = null;
  /** Block whose handle was PINNED by a click (field bug: in row layouts the
   *  trip to the pill crosses a SIBLING block, which steals the hover and
   *  hides the pill). While set, hover no longer moves the handle; the pin
   *  drops on a click over empty space / another block, Escape, a text
   *  session, a drag or a delete. */
  let pinnedBlock: HTMLElement | null = null;
  let dragging = false;
  let repositionQueued = false;
  let destroyed = false;

  // --- single undo timeline: per-edit journal checkpoints --------------------
  // There is ONE undo timeline — the main journal mirrored by `history`. A text
  // session no longer commits as one big editText op; instead it cuts a
  // CHECKPOINT (one history entry + one editText op carrying the block's
  // cumulative innerHTML) at each edit boundary (typed space / Enter / a format
  // / a click to a new spot / commit). So ⌘Z steps per edit, not per block.
  // These track the last checkpoint's state for the OPEN session only.
  let cpHtml = ''; // stamped innerHTML at the last checkpoint
  let cpNormalized = ''; // normalize(cpHtml)
  let pushedThisSession = 0; // checkpoints emitted in the current session (floor 0)
  let dirtyTail = false; // content changed since the last checkpoint (drives canUndo)

  const overlay = new Overlay(doc, {
    onDelete: () => deleteBlockAction(),
    onDuplicate: () => duplicateBlockAction(),
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
          const entry = history.push({ kind: 'moveBlock', node: moved, parent, oldNext, newNext: moved.nextSibling });
          void pushOp({ type: 'moveBlock', id, beforeId }, entry);
        },
        onEnd: () => {
          dragging = false;
          pinnedBlock = null; // the drop moved the block — hover takes over again
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
    onBlockType: () => {}, // block-type change is an MD-controller feature
  }, format);

  /** Last selection range shown in the toolbar — restored for link actions
   *  (the link input legitimately steals focus and with it the selection). */
  let lastSelectionRange: Range | null = null;
  let toolbarUpdateQueued = false;

  // --- undo/redo availability (titlebar buttons) ----------------------------

  /**
   * Push the current undo/redo availability to the shell (via main). There is
   * ONE timeline now (the journal mirrored by `history`):
   *   canRedo = history.canRedo — true ONLY after an undo, cleared by any new
   *     edit (push() truncates the redo tail). So Redo is hidden the instant you
   *     click into a block and appears only once you've actually undone something.
   *   canUndo = history.canUndo OR the open session has an un-checkpointed tail
   *     (dirtyTail) — so Undo appears the moment you change something, but NOT on
   *     a bare click-in with nothing typed yet.
   * Emitted on every transition: after a checkpoint, after handleUndo/Redo, on
   * session begin/end, and on the first keystroke of a session.
   */
  let lastCanUndo: boolean | null = null;
  let lastCanRedo: boolean | null = null;
  function emitAvailability(): void {
    const canUndo = history.canUndo || dirtyTail;
    const canRedo = history.canRedo;
    if (canUndo === lastCanUndo && canRedo === lastCanRedo) return;
    lastCanUndo = canUndo;
    lastCanRedo = canRedo;
    bridge.emitAvailability({ canUndo, canRedo });
  }

  // --- op transport ---------------------------------------------------------

  // Single-flight FIFO so every journal-mutating IPC (push/undo/redo) reaches
  // main strictly in enqueue order, each awaiting the prior. Without it a burst
  // (N checkpoints then N undos in one synchronous tick) could land out of
  // order and desync the main journal cursor from the local stack. A failed
  // task never breaks the chain (errors are swallowed for ordering only).
  let opChain: Promise<unknown> = Promise.resolve();
  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = opChain.catch(() => {}).then(task);
    opChain = run.catch(() => {});
    return run;
  }

  function pushOp(
    op: Parameters<RedraDocBridge['pushOp']>[0],
    entry: HistoryEntry,
    onReject?: () => void,
  ): Promise<void> {
    return enqueue(() => pushOpCore(op, entry, onReject));
  }

  async function pushOpCore(
    op: Parameters<RedraDocBridge['pushOp']>[0],
    entry: HistoryEntry,
    onReject?: () => void,
  ): Promise<void> {
    const res = await bridge.pushOp(op);
    if (!res.ok) {
      // Main is the source of truth: the journal never recorded this op, so the
      // local entry it created must go too — by IDENTITY, because under the FIFO
      // transport this rejection may resolve after a LATER sync push already
      // landed on top (popping the top would corrupt the stack). discardEntry
      // reverts the DOM where safe so the action visibly bounces back; main's
      // localized userMessage (stale-doc rejections stay silent) becomes a toast.
      console.error('[redra] ops:push rejected:', res.error, op);
      history.discardEntry(entry);
      // A checkpoint push also moved controller-local state (pushedThisSession,
      // cpHtml/cpNormalized) the generic history rollback doesn't know about —
      // the caller reverses exactly that, keeping the session's undo accounting
      // in lockstep with the journal that recorded nothing.
      onReject?.();
      if (res.userMessage) bridge.notifyRejected(res.userMessage);
    }
    emitAvailability(); // a push (or its rollback) changed the history stack
  }

  /** Journal undo/redo, serialized through the FIFO so they never overtake a
   *  still-in-flight push (the burst-desync the queue exists to prevent). */
  function queuedUndo(): Promise<void> {
    return enqueue(async () => {
      const res = await bridge.undo();
      if (!res.ok) console.error('[redra] undo desync: journal had nothing to undo');
    });
  }
  function queuedRedo(): Promise<void> {
    return enqueue(async () => {
      const res = await bridge.redo();
      if (!res.ok) console.error('[redra] redo desync: journal had nothing to redo');
    });
  }

  /**
   * Cut one undo checkpoint for the open session: a history entry + an editText
   * op carrying the block's CUMULATIVE stamped innerHTML (prevHtml = the last
   * checkpoint, newHtml = now). A no-op (normalized content unchanged since the
   * last checkpoint) emits nothing — so a trailing space that doesn't change the
   * text makes no empty step. Re-editText on the block's OWN pristine id is
   * engine-legal ("re-editText replaces the replacement", op-guard contract).
   * Reads el/id off the passed session so the final flush still works after the
   * global `session` was nulled at the top of endSession.
   */
  function flushCheckpoint(s: EditSessionState): boolean {
    const cur = s.el.innerHTML;
    const curN = normalize(cur);
    const changed = curN !== cpNormalized;
    if (changed) {
      // Snapshot the pre-checkpoint baseline so a rejected push can reverse
      // the controller-local accounting in lockstep with history.undoAndDiscard
      // (which reverts the newest entry — this very checkpoint). pushOpCore
      // guarantees onReject runs only for THIS op's rejection.
      const prevHtml = cpHtml;
      const prevNormalized = cpNormalized;
      const entry = history.push({ kind: 'editText', el: s.el, prevHtml, newHtml: cur });
      pushedThisSession++;
      cpHtml = cur;
      cpNormalized = curN;
      const wire = curN.length > HEAVY_STAMPED_ATTR_LIMIT ? stubHeavyStampedAttrs(curN) : curN;
      void pushOp({ type: 'editText', id: s.id, html: wire }, entry, () => {
        // Main rejected this checkpoint: discardEntry already dropped the entry.
        // Roll the session's own counters back to the pre-checkpoint baseline so
        // endSession/handleUndo never send a bridge.undo the journal can't match.
        pushedThisSession = Math.max(0, pushedThisSession - 1);
        cpHtml = prevHtml;
        cpNormalized = prevNormalized;
      });
    }
    dirtyTail = false; // the tail is sealed (whether or not it changed anything)
    emitAvailability();
    return changed;
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
    const entry = history.push({ kind: 'setAttr', el: img, name: 'src', prevValue, newValue: value });
    void pushOp({ type: 'setAttr', id, name: 'src', value }, entry);
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

  /**
   * Toggle a bare inline tag (code, tg-spoiler) over the selection. execCommand
   * has no native command for these, so compute the wrap/unwrap and apply it as
   * ONE insertHTML — it lands on the same native undo stack as bold/italic, and
   * falls back to direct Range surgery when execCommand is unavailable (jsdom).
   */
  function toggleInline(tag: string): void {
    if (!session) return;
    const sel = win.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!session.el.contains(range.commonAncestorContainer)) return;
    const plan = computeInlineToggle(range, tag, session.el);
    sel.removeAllRanges();
    sel.addRange(plan.selectRange);
    const inserted = doc.execCommand?.('insertHTML', false, plan.html) === true;
    if (!inserted) {
      toggleInlineTag(range, tag, session.el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function handleToolbarAction(action: ToolbarAction, value?: string): void {
    if (!session) return;
    // Seal the typed tail as its OWN step before the format, then the format as
    // its own step after — so ⌘Z peels format → typing in chronological order
    // (native undo no longer carries this; checkpoints do). A no-op format
    // (empty link, unlink-with-no-link) flushes to nothing via the equality
    // guard, so no spurious empty steps.
    flushCheckpoint(session);
    switch (action) {
      case 'bold':
        doc.execCommand?.('bold');
        break;
      case 'italic':
        doc.execCommand?.('italic');
        break;
      case 'underline':
        doc.execCommand?.('underline');
        break;
      case 'strike':
        doc.execCommand?.('strikeThrough');
        break;
      case 'code':
        toggleInline('code');
        break;
      case 'spoiler':
        // Telegram spoiler — a bare <tg-spoiler> toggle (same machinery as code).
        toggleInline('tg-spoiler');
        break;
      case 'mark':
        toggleInline('mark');
        break;
      case 'sub':
        toggleInline('sub');
        break;
      case 'sup':
        toggleInline('sup');
        break;
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
    if (session) flushCheckpoint(session); // seal the format as its own step
  }

  // --- edit sessions (A1) ----------------------------------------------------

  function startSession(el: HTMLElement, clickX?: number, clickY?: number): void {
    pinnedBlock = null; // a text session supersedes a click-pin
    clearHover();
    const s = beginSession(el, normalize);
    if (!s) return;
    session = s;
    el.focus({ preventScroll: true });
    placeCaret(el, clickX, clickY);
    // The handle stays anchored to the block being edited so duplicate/trash
    // remain reachable mid-edit. Its box changes as the user types (a growing
    // paragraph, a new line) — keep it re-anchored on every input. mouseover/
    // refreshHoverUnderPointer are dormant during a session, so this handle is
    // the only block UI on screen; no OTHER block can highlight.
    overlay.showHandle(el);
    el.addEventListener('input', onSessionInput);
    // Seed the checkpoint baseline at the pristine content; no checkpoint is
    // cut on a bare click-in, so Undo/Redo stay hidden until the user edits.
    cpHtml = s.originalHtml;
    cpNormalized = s.originalNormalized;
    pushedThisSession = 0;
    dirtyTail = false;
    emitAvailability();
  }

  /**
   * Per-keystroke work during a session: keep the handle anchored as the box
   * grows; mark the tail dirty (so Undo appears the moment you change
   * something); and at a word/line boundary cut an undo CHECKPOINT so ⌘Z steps
   * per edit. The boundary also gets the no-op selection touch (harmless;
   * preserves IME/caret continuity) before the checkpoint is flushed.
   */
  function onSessionInput(e: Event): void {
    if (!session) return;
    if (!dirtyTail) {
      dirtyTail = true;
      emitAvailability(); // first change in this segment — reveal Undo
    }
    const ie = e as InputEvent;
    if (isUndoGroupBoundary(ie.inputType, ie.data)) {
      const sel = win.getSelection?.();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).cloneRange();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      flushCheckpoint(session);
    }
    queueReposition();
  }

  async function endSession(commit: boolean): Promise<void> {
    const s = session;
    if (!s) return;
    const n = Math.max(0, pushedThisSession); // capture before any reset
    session = null; // cleared first: the blur this triggers must be a no-op
    lastSelectionRange = null;
    overlay.toolbar.hide();
    s.el.removeEventListener('input', onSessionInput);
    overlay.hideHandle(); // drop the session anchor; hover takes over again
    if (!commit) {
      // Escape / trash mid-edit: undo EVERY checkpoint this session pushed,
      // then restore the pristine innerHTML — nets zero ops, leaves no redo
      // tail, keeps the local stack and the journal cursor in lockstep.
      for (let i = 0; i < n; i++) {
        history.undoAndDiscard();
        void queuedUndo();
      }
      pushedThisSession = 0;
      dirtyTail = false;
      revertSession(s);
      emitAvailability();
      return;
    }
    // Commit = ONE final flush capturing the tail typed since the last
    // boundary, then tear down the editing affordances. No separate
    // single-editText commit anymore. Await the queue so the commit barrier
    // (commitActive/duplicate .then(), main's edit:committed ack) still fires
    // only after the editText is journaled.
    flushCheckpoint(s);
    endVisuals(s.el);
    pushedThisSession = 0;
    dirtyTail = false;
    emitAvailability();
    await opChain;
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

  /**
   * After a mid-session undo/redo swaps el.innerHTML, the live Range is
   * detached — re-place the caret at the END of the (reverted) content. End is
   * the safe, deterministic choice across Chromium and jsdom (placeCaret with
   * no x/y collapses to end); mapping the exact pre-undo offset across the
   * innerHTML swap is deferred (see the undo-checkpoint probe).
   */
  function replaceCaretAtEnd(el: HTMLElement): void {
    el.focus({ preventScroll: true });
    placeCaret(el);
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

  /** Pin the handle to a clicked block (null / page wrapper = unpin). The
   *  visual state is the same hover wash + pill — it just stops following
   *  the mouse until the next click decides otherwise. */
  function pinBlock(block: HTMLElement | null): void {
    pinnedBlock = block && !isPageWrapper(block) ? block : null;
    setHover(pinnedBlock);
  }

  /**
   * Block duplication: unlike other ops the journal push happens in MAIN
   * inside the one 'ops:cloneBlock' invoke (it mints the cloneId), so the
   * DOM changes only AFTER main confirmed — no rollback path needed. The
   * returned fragment is STAMPED (cloneId / cloneId-n), so hover, edit,
   * drag and delete work on the copy immediately.
   */
  function duplicateBlock(block: HTMLElement): void {
    if (dragging) return;
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
        void queuedUndo();
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
      emitAvailability();
    });
  }

  function deleteBlock(block: HTMLElement): void {
    const id = block.getAttribute(REDRA_ID_ATTR);
    const parent = block.parentNode as (Node & ParentNode) | null;
    if (!id || !parent) return;
    pinnedBlock = null; // the pinned block (if any) is about to vanish
    clearHover();
    const entry = history.push({ kind: 'deleteBlock', node: block, parent, nextSibling: block.nextSibling });
    block.remove();
    emitAvailability();
    void pushOp({ type: 'deleteBlock', id }, entry);
  }

  // --- handle-pill actions (hover OR active-session block) -------------------

  /**
   * The handle pill button targets either the hovered block or — when a text
   * edit session is open — the block being edited (its handle stays anchored
   * so the buttons remain reachable mid-edit). The session takes precedence:
   * duplicate COMMITS the typed text first so the copy includes it; trash
   * REVERTS the in-progress edit (no editText op) before removing the block.
   */
  function targetBlock(): HTMLElement | null {
    return session?.el ?? overlay.currentBlock;
  }

  function duplicateBlockAction(): void {
    if (dragging) return;
    const block = targetBlock();
    if (!block) return;
    if (session) {
      // Commit the edit so the typed text rides along into the clone, THEN
      // duplicate the now-up-to-date block.
      void endSession(true).then(() => duplicateBlock(block));
      return;
    }
    duplicateBlock(block);
  }

  function deleteBlockAction(): void {
    if (dragging) return;
    const block = targetBlock();
    if (!block) return;
    if (session) {
      // Discard the in-progress edit (revert, no editText op) before deleting
      // — the block is about to vanish, so its typed text must not be recorded.
      void endSession(false);
    }
    deleteBlock(block);
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
    // page's own handlers stay suppressed. Clicking to a NEW spot seals the
    // edits made at the old spot as their own undo step — so fixing three
    // places in one block gives three undo steps even without typed spaces.
    if (session && session.el.contains(target)) {
      flushCheckpoint(session);
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
    if (editable) {
      startSession(editable, e.clientX, e.clientY);
      return;
    }
    // Non-editable click: pin the handle to the clicked block, or unpin on
    // empty space. A pinned pill survives the pointer crossing sibling blocks
    // on its way to the icons — the row-layout case hover alone can't serve.
    pinBlock(resolveBlock(target, win));
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
    if (pinnedBlock) {
      // The pill is pinned by a click — hover must not move it. The image
      // chip is a separate affordance ON the img itself, so it keeps working.
      const img = asReplaceableImage(target);
      if (img) overlay.showImageChip(img);
      else overlay.hideImageChip();
      return;
    }
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
    // A pinned pill must not be stolen by whatever scrolls under the pointer —
    // reposition() already keeps it glued to the pinned block's new rect.
    if (session || dragging || pinnedBlock || !lastPointer) return;
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
    // Pointer left the window entirely. A pinned pill stays — it only drops
    // on an explicit click (or Escape), never because the mouse wandered.
    if (e.relatedTarget === null && !dragging && !pinnedBlock) setHover(null);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Keys typed into overlay chrome (the link input) are the toolbar's own.
    if (overlay.containsTarget(e.target)) return;
    if (e.key !== 'Escape') return;
    if (session) {
      e.preventDefault();
      e.stopImmediatePropagation();
      void endSession(false); // Escape REVERTS — no op recorded
      return;
    }
    if (pinnedBlock) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pinBlock(null); // Escape drops the click-pin
    }
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
        // Establish the shell's baseline: a freshly-opened doc has an empty
        // history and no session, so both buttons start disabled.
        emitAvailability();
      } else {
        // Main commits the session before flipping the mode; this is the
        // belt-and-braces path for a commit that raced or timed out.
        void endSession(true);
        pinnedBlock = null;
        clearHover();
        disarm();
      }
    },
    commitActive(): Promise<void> {
      return endSession(true);
    },
    handleUndo(): void {
      // ONE timeline — always the journal. While a session is open, first
      // materialize the in-flight tail as a real checkpoint so a half-typed
      // word is undoable, then step the journal.
      if (session) {
        flushCheckpoint(session);
        // Cross-block guard: never revert a PRIOR block under the live caret.
        // When this session has no more of its own checkpoints to undo, commit
        // it; the NEXT ⌘Z then takes the post-commit path for the prior block.
        if (pushedThisSession <= 0) {
          void endSession(true);
          return;
        }
      }
      if (!history.canUndo) return;
      history.undo();
      void queuedUndo();
      if (session) {
        // We reverted one of THIS session's checkpoints — re-sync the baseline
        // so continued typing re-segments and the commit never double-counts.
        pushedThisSession = Math.max(0, pushedThisSession - 1);
        cpHtml = session.el.innerHTML;
        cpNormalized = normalize(cpHtml);
        dirtyTail = false;
        replaceCaretAtEnd(session.el);
      }
      emitAvailability();
    },
    handleRedo(): void {
      if (!history.canRedo) return;
      // Cross-block guard (mirror of handleUndo): while a session is open, a
      // redo may ONLY re-apply one of THIS session's own checkpoints. A stale
      // redo tail left by a PRIOR committed block must never re-apply under the
      // live caret — that would resurrect the prior block's edit and poison this
      // session's checkpoint accounting (a later Escape would then silently
      // revert the prior block + desync the journal). The next redo entry
      // belongs to this session iff it targets session.el.
      if (session) {
        const next = history.nextRedo;
        if (!(next && next.kind === 'editText' && next.el === session.el)) return;
      }
      history.redo();
      void queuedRedo();
      if (session) {
        // Mid-session redo re-applied one of this session's checkpoints.
        pushedThisSession++;
        cpHtml = session.el.innerHTML;
        cpNormalized = normalize(cpHtml);
        dirtyTail = false;
        replaceCaretAtEnd(session.el);
      }
      emitAvailability();
    },
    turnInto(): void {
      // Block-type change is Markdown-only and lives in the md controller.
    },
    applyFormat(action: ToolbarAction): void {
      // handleToolbarAction already no-ops without a session / with a collapsed
      // selection for the wrap toggles, so a menu shortcut fired at the wrong
      // moment is harmless.
      if (destroyed) return;
      handleToolbarAction(action);
    },
    showTip(text: string, x: number, y: number): void {
      if (destroyed) return;
      overlay.showTip(text, x, y);
    },
    hideTip(): void {
      overlay.hideTip();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (editing) disarm();
      editing = false;
      session = null;
      pinnedBlock = null;
      clearHover();
      overlay.destroy();
    },
  };
}
