/**
 * MD 2.0 editing layer: the document is TEXT.
 *
 * One <main> is the single contenteditable host — click anywhere and type,
 * including past the end of the file. Enter makes paragraphs and list items
 * natively (defaultParagraphSeparator=p), Backspace merges blocks, code
 * blocks edit as text, checkboxes toggle. There are no per-block sessions,
 * no handles, no pins, no blocked states: block identity exists only in the
 * stamps the renderer left behind, and the SAVE side (md-body-diff) uses
 * them to keep untouched blocks byte-faithful.
 *
 * Undo/redo are Chromium's own editing stack (every mutation here happens
 * through user input or execCommand, so one native timeline covers it all);
 * availability for the titlebar buttons is polled via queryCommandEnabled.
 * The only self-inverse exception is the task checkbox — toggling is its own
 * undo.
 *
 * Edits reach main as (a) a one-shot 'md:dirty' per input generation and
 * (b) whole-body commits at commit points ('edit:commit' → md:commitBody).
 * The generation counter travels with both so main can tell a body that
 * caught up from one that went stale (loss-race guards from the design
 * review).
 */
import { makeT, pickLang } from '../../shared/i18n.js';
import type { RedraDocBridge } from '../../shared/ipc.js';
import type { BlockKind } from '../../shared/doc-types.js';
import type { EditorController } from './controller.js';
import { SelectionToolbar, selectionContext, TOOLBAR_CSS } from './toolbar.js';
import type { ToolbarAction } from './toolbar.js';
import { SlashMenu, SLASH_CSS } from './slash-menu.js';
import { computeInlineToggle, toggleInlineTag } from './format.js';

/** Minimal chrome CSS: the titlebar tooltip (same look as the HTML overlay). */
const MD_CHROME_CSS = `
:host { all: initial; }
.tb-tip {
  position: fixed;
  display: none;
  max-width: 280px;
  padding: 3px 9px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(28, 27, 25, 0.09);
  box-shadow: 0 3px 10px rgba(20, 18, 14, 0.14);
  color: #1c1b19;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
}
.tb-tip.visible { display: block; }
@media (prefers-color-scheme: dark) {
  .tb-tip {
    background: rgba(35, 34, 32, 0.97);
    border-color: rgba(236, 234, 230, 0.12);
    color: #eceae6;
  }
}
@media print {
  .tb-tip, .fmtbar, .fmtpanel { display: none !important; }
}
`;

const CHECKBOX_HTML = '<input type="checkbox" contenteditable="false" tabindex="-1"> ';

export function createMdEditorController(
  win: Window,
  bridge: RedraDocBridge,
  docId: string,
): EditorController {
  const doc = win.document;
  const mainEl = (doc.querySelector('main') ?? doc.body) as HTMLElement;

  let editing = false;
  let destroyed = false;

  // Renderer input generation: bumped on every edit; announced to main once
  // per dirty period (re-armed at each commit snapshot — see commitActive).
  let gen = 0;
  let dirtyAnnounced = false;

  function noteInput(): void {
    gen += 1;
    if (!dirtyAnnounced) {
      dirtyAnnounced = true;
      bridge.mdDirty?.(docId, gen);
    }
    queueAvailability();
    queueToolbarUpdate();
  }

  // --- chrome host (closed shadow: toolbar + titlebar tip) -------------------
  const host = doc.createElement('div');
  for (const [prop, value] of [
    ['position', 'fixed'],
    ['left', '0'],
    ['top', '0'],
    ['width', '0'],
    ['height', '0'],
    ['z-index', '2147483647'],
  ] as const) {
    host.style.setProperty(prop, value, 'important');
  }
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = MD_CHROME_CSS + TOOLBAR_CSS + SLASH_CSS;
  shadow.appendChild(style);
  const tip = doc.createElement('div');
  tip.className = 'tb-tip';
  shadow.appendChild(tip);
  doc.documentElement.appendChild(host);

  const t = makeT(pickLang(navigator.language));
  // "/" in an empty block → pick what the next text becomes (Notion pattern).
  const slash = new SlashMenu(doc, shadow, t, (kind) => applyBlockType(kind));
  const toolbar = new SelectionToolbar(
    doc,
    shadow,
    t,
    (action, value) => handleToolbarAction(action, value),
    'md',
    (kind) => applyBlockType(kind),
  );

  // --- selection / toolbar ----------------------------------------------------
  let lastSelectionRange: Range | null = null;
  let toolbarQueued = false;

  function updateToolbar(): void {
    // The URL input legitimately steals focus/selection — a selectionchange
    // must not tear the link editor down mid-typing.
    if (toolbar.linkMode) return;
    const ctx = selectionContext(win, doc, mainEl);
    if (!ctx) {
      toolbar.hide();
      return;
    }
    lastSelectionRange = ctx.range.cloneRange();
    toolbar.show(ctx.rect, ctx.state);
  }

  function queueToolbarUpdate(): void {
    if (toolbarQueued) return;
    toolbarQueued = true;
    win.requestAnimationFrame(() => {
      toolbarQueued = false;
      if (editing && !destroyed) updateToolbar();
    });
  }

  function restoreSelection(): void {
    const sel = win.getSelection?.();
    if (!sel || !lastSelectionRange) return;
    mainEl.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(lastSelectionRange);
  }

  // --- availability (native undo stack) ---------------------------------------
  let availQueued = false;
  function emitAvailability(): void {
    const enabled = (cmd: string): boolean => {
      try {
        return doc.queryCommandEnabled?.(cmd) ?? false;
      } catch {
        return false;
      }
    };
    bridge.emitAvailability({ canUndo: enabled('undo'), canRedo: enabled('redo') });
  }
  function queueAvailability(): void {
    if (availQueued) return;
    availQueued = true;
    win.requestAnimationFrame(() => {
      availQueued = false;
      if (!destroyed) emitAvailability();
    });
  }

  // --- inline formats ----------------------------------------------------------
  function toggleInline(tag: string): void {
    const sel = win.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!mainEl.contains(range.commonAncestorContainer)) return;
    const plan = computeInlineToggle(range, tag, mainEl);
    sel.removeAllRanges();
    sel.addRange(plan.selectRange);
    const inserted = doc.execCommand?.('insertHTML', false, plan.html) === true;
    if (!inserted) {
      toggleInlineTag(range, tag, mainEl);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function handleToolbarAction(action: ToolbarAction, value?: string): void {
    if (!editing) return;
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
    noteInput();
  }

  // --- block types (native commands over the selection) ------------------------
  function currentBlockTag(): string | null {
    const sel = win.getSelection?.();
    const node = sel?.anchorNode ?? null;
    if (!node || !mainEl.contains(node)) return null;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const block = el?.closest('h1,h2,h3,h4,h5,h6,p,pre,blockquote');
    return block && mainEl.contains(block) ? block.tagName.toLowerCase() : null;
  }

  function applyBlockType(kind: BlockKind): void {
    if (!editing) return;
    const format = (tag: string): void => {
      // Same tag again = toggle back to a paragraph (heading/quote/pre).
      const target = currentBlockTag() === tag ? 'p' : tag;
      doc.execCommand?.('formatBlock', false, `<${target}>`);
    };
    switch (kind) {
      case 'h1':
      case 'h2':
      case 'h3':
        format(kind);
        break;
      case 'paragraph':
        doc.execCommand?.('formatBlock', false, '<p>');
        break;
      case 'ul':
        doc.execCommand?.('insertUnorderedList');
        break;
      case 'ol':
        doc.execCommand?.('insertOrderedList');
        break;
      case 'task': {
        // A bullet list whose items carry the task checkbox. Native lists
        // first; then mark every li the selection touches.
        const sel = win.getSelection?.();
        const anchor = sel?.anchorNode ?? null;
        const inList = !!(anchor && (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement)?.closest('ul,ol'));
        if (!inList) doc.execCommand?.('insertUnorderedList');
        const sel2 = win.getSelection?.();
        const node = sel2?.anchorNode ?? null;
        const li = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('li');
        const list = li?.closest('ul,ol');
        if (list && mainEl.contains(list)) {
          const items =
            sel2 && !sel2.isCollapsed
              ? Array.from(list.querySelectorAll('li')).filter((item) => sel2.containsNode(item, true))
              : li
                ? [li]
                : [];
          for (const item of items.length ? items : li ? [li] : []) {
            // Native list surgery (Enter splits, re-listing) can leave a
            // checkbox at ANY depth or duplicate it — normalize hard: strip
            // every input in the item, then re-add exactly one when marking.
            const boxes = Array.from(item.querySelectorAll('input[type="checkbox"]'));
            for (const b of boxes) b.remove();
            if (item.classList.contains('md-task')) {
              item.classList.remove('md-task', 'md-task-done');
            } else {
              item.classList.add('md-task');
              item.insertAdjacentHTML('afterbegin', CHECKBOX_HTML);
            }
          }
        }
        break;
      }
      case 'blockquote':
        format('blockquote');
        break;
      case 'pre':
        format('pre');
        break;
      case 'hr':
        doc.execCommand?.('insertHorizontalRule');
        break;
    }
    noteInput();
  }

  // --- listeners ----------------------------------------------------------------
  function onInput(): void {
    noteInput();
  }

  function onSelectionChange(): void {
    if (!editing) return;
    queueToolbarUpdate();
    queueAvailability();
  }

  function onClick(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    // Cmd+click a link: open externally (links never navigate inside CE).
    if (e.metaKey || e.ctrlKey) {
      const anchor = target.closest('a[href]');
      if (anchor) {
        e.preventDefault();
        e.stopImmediatePropagation();
        bridge.openExternal((anchor as HTMLAnchorElement).href);
        return;
      }
    }
    // Click on <main> itself (its padding / the run-out below the last
    // block). Left alone, Chromium collapses the caret BETWEEN child blocks
    // of the container and renders it as tall as the whole content — the
    // red "orange stripe". Route every such click to a real text position:
    //   • beside a block (same Y band) → caret at its start/end;
    //   • between blocks → caret at the start of the next block;
    //   • below the last block → a fresh paragraph (the "дописать" click).
    if (editing && target === mainEl) {
      e.preventDefault();
      const blocks = Array.from(mainEl.children) as HTMLElement[];
      const last = blocks[blocks.length - 1] ?? null;
      if (last && e.clientY <= last.getBoundingClientRect().bottom) {
        for (const block of blocks) {
          const r = block.getBoundingClientRect();
          if (e.clientY <= r.bottom) {
            placeCaret(block, e.clientX > r.right);
            return;
          }
        }
        return;
      }
      if (last && last.tagName === 'P' && (last.textContent ?? '').trim() === '') {
        placeCaretIn(last);
        return;
      }
      const p = doc.createElement('p');
      p.appendChild(doc.createElement('br'));
      mainEl.appendChild(p);
      placeCaretIn(p);
      noteInput();
    }
  }

  /** The block-level child of <main> the caret currently sits in, if any. */
  function caretBlock(): HTMLElement | null {
    const sel = win.getSelection?.();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || !mainEl.contains(node)) return null;
    let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
    while (el && el.parentElement !== mainEl) el = el.parentElement;
    return el instanceof HTMLElement ? el : null;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!editing) return;
    if (slash.visible) {
      if (slash.handleKey(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Only in an EMPTY block: mid-text a slash is just a slash (paths,
      // fractions), and the empty-block case is exactly "what comes next?".
      const block = caretBlock();
      if (block && (block.textContent ?? '').trim() === '') {
        e.preventDefault();
        e.stopImmediatePropagation();
        slash.open(block.getBoundingClientRect());
      }
    }
  }

  function onChange(e: Event): void {
    // Task checkbox toggled — sync the class the theme dims by, and count it
    // as an edit (self-inverse: not on the native undo stack by design).
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      // A click flips the PROPERTY only — innerHTML serializes the ATTRIBUTE,
      // so the commit body would carry the stale state without this sync.
      if (target.checked) target.setAttribute('checked', '');
      else target.removeAttribute('checked');
      const li = target.closest('li');
      if (li) {
        li.classList.toggle('md-task-done', target.checked);
        // Editing surgery sometimes duplicates the box — the clicked one wins.
        for (const other of Array.from(li.querySelectorAll('input[type="checkbox"]'))) {
          if (other !== target) other.remove();
        }
      }
      noteInput();
    }
  }

  function placeCaretIn(el: Element): void {
    placeCaret(el, false);
  }

  /** Collapse the caret to the start (or end) of `el`'s CONTENTS — never onto
   *  a <main>-level boundary, where Chromium paints a content-tall caret. */
  function placeCaret(el: Element, atEnd: boolean): void {
    const sel = win.getSelection?.();
    if (!sel) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(!atEnd);
    sel.removeAllRanges();
    sel.addRange(range);
    mainEl.focus({ preventScroll: true });
  }

  const listeners: Array<[EventTarget, string, EventListener, boolean | AddEventListenerOptions]> = [
    [mainEl, 'input', onInput as EventListener, false],
    [doc, 'selectionchange', onSelectionChange as EventListener, false],
    [doc, 'click', onClick as EventListener, true],
    [doc, 'keydown', onKeyDown as EventListener, true],
  ];
  // The checkbox sync lives for the CONTROLLER's lifetime, not the armed
  // period: Preview makes the inputs inert via CSS, but any toggle that still
  // lands (keyboard, programmatic) must never desync attribute/class/dirty.
  mainEl.addEventListener('change', onChange);

  function arm(): void {
    mainEl.setAttribute('contenteditable', 'true');
    mainEl.setAttribute('spellcheck', 'false');
    try {
      doc.execCommand?.('defaultParagraphSeparator', false, 'p');
    } catch {
      /* jsdom */
    }
    for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
    // A new-file starter: put the caret straight into the placeholder heading.
    const ph = mainEl.querySelector('[data-redra-ph]');
    if (ph) placeCaretIn(ph);
    emitAvailability();
  }

  function disarm(): void {
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    toolbar.hide();
    slash.close();
    mainEl.removeAttribute('contenteditable');
    mainEl.removeAttribute('spellcheck');
  }

  return {
    setEditing(next: boolean): void {
      if (destroyed || next === editing) return;
      editing = next;
      if (editing) arm();
      else disarm();
    },
    commitActive(): Promise<boolean> {
      // Snapshot atomically (no awaits between), then RE-ARM the dirty
      // notifier: any keystroke after this snapshot must announce a fresh
      // generation or it could be lost to the save that is about to run.
      const snapshotGen = gen;
      const html = mainEl.innerHTML;
      dirtyAnnounced = false;
      return (bridge.commitMdBody?.(docId, html, snapshotGen) ?? Promise.resolve({ ok: false })).then(
        (res) => res.ok === true,
        () => false,
      );
    },
    handleUndo(): void {
      // Guards: never in Preview, and never mark a pristine doc dirty for a
      // no-op undo (⌘Z with an empty native stack).
      if (!editing) return;
      if (!(doc.queryCommandEnabled?.('undo') ?? false)) return;
      doc.execCommand?.('undo');
      noteInput();
    },
    handleRedo(): void {
      if (!editing) return;
      if (!(doc.queryCommandEnabled?.('redo') ?? false)) return;
      doc.execCommand?.('redo');
      noteInput();
    },
    turnInto(kind: BlockKind): void {
      applyBlockType(kind);
    },
    applyFormat(action: ToolbarAction): void {
      if (destroyed) return;
      handleToolbarAction(action);
    },
    showTip(text: string, x: number, y: number): void {
      if (destroyed) return;
      tip.textContent = text;
      tip.classList.add('visible');
      const half = tip.offsetWidth / 2;
      const vw = doc.documentElement.clientWidth;
      const cx = Math.max(half + 6, Math.min(x, vw - half - 6));
      tip.style.left = `${cx}px`;
      tip.style.top = `${y}px`;
    },
    hideTip(): void {
      tip.classList.remove('visible');
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (editing) disarm();
      editing = false;
      mainEl.removeEventListener('change', onChange);
      host.remove();
    },
  };
}
