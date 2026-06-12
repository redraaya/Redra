import type { Translate } from '../../shared/i18n.js';
import { closestTag } from './format.js';

/**
 * Floating inline-formatting toolbar shown over a non-collapsed selection
 * during an active edit session (Feature 3, v0.2.0).
 *
 * Pure overlay chrome: it renders inside the Overlay's closed shadow root
 * (constructor takes any parent node, so tests mount it in a plain div) and
 * reports button presses through ONE callback — all editing logic (exec
 * commands, Range surgery, selection restore) stays in the controller.
 *
 * Quiet design per the approved mockup language: a pill bar with a hairline
 * border, white/dark surface like the block handle, four 26px buttons.
 * Buttons use mousedown-preventDefault so they never steal focus from the
 * contenteditable; the link input is the one deliberate exception.
 */

export type ToolbarAction = 'bold' | 'italic' | 'code' | 'link' | 'unlink';

export interface ToolbarState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  /** href of the <a> the selection sits in, or null when not in a link. */
  link: string | null;
}

export interface RectLike {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export const TOOLBAR_CSS = `
.fmtbar {
  position: fixed;
  display: none;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(28, 27, 25, 0.09);
  box-shadow: 0 3px 10px rgba(20, 18, 14, 0.12);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  z-index: 2;
}
.fmtbar.visible { display: flex; }
.fmtbar button {
  all: initial;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  cursor: pointer;
  color: #6f6c64;
  font-family: inherit;
  font-size: 13px;
}
.fmtbar button:hover { background: rgba(28, 27, 25, 0.06); color: #1c1b19; }
.fmtbar button.active { background: rgba(28, 27, 25, 0.09); color: #1c1b19; }
.fmtbar .b { font-weight: 700; }
.fmtbar .i { font-style: italic; font-family: Georgia, serif; }
.fmtbar .c { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; }
.fmtbar input {
  all: initial;
  width: 180px;
  height: 26px;
  padding: 0 8px;
  font-family: inherit;
  font-size: 12px;
  color: #1c1b19;
  caret-color: #d9482b;
}
.fmtbar input::placeholder { color: #a09d95; }
@media (prefers-color-scheme: dark) {
  .fmtbar {
    background: rgba(35, 34, 32, 0.97);
    border-color: rgba(236, 234, 230, 0.12);
  }
  .fmtbar button { color: #8f8c84; }
  .fmtbar button:hover { background: rgba(236, 234, 230, 0.08); color: #eceae6; }
  .fmtbar button.active { background: rgba(236, 234, 230, 0.12); color: #eceae6; }
  .fmtbar input { color: #eceae6; caret-color: #ff6b4a; }
  .fmtbar input::placeholder { color: #6f6c64; }
}
@media print {
  .fmtbar { display: none !important; }
}
`;

const LINK_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

const UNLINK_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
  '<line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/>' +
  '<line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>';

export class SelectionToolbar {
  private readonly bar: HTMLElement;
  private readonly buttons: { bold: HTMLButtonElement; italic: HTMLButtonElement; code: HTMLButtonElement; link: HTMLButtonElement };
  private readonly linkInput: HTMLInputElement;
  private readonly unlinkBtn: HTMLButtonElement;
  private readonly doc: Document;
  private state: ToolbarState = { bold: false, italic: false, code: false, link: null };
  private inLinkMode = false;

  constructor(
    doc: Document,
    parent: ParentNode,
    t: Translate,
    private readonly onAction: (action: ToolbarAction, value?: string) => void,
  ) {
    this.doc = doc;
    this.bar = doc.createElement('div');
    this.bar.className = 'fmtbar';

    const makeButton = (
      cls: string,
      title: string,
      content: { text?: string; html?: string },
      onClick: () => void,
    ): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.className = cls;
      b.setAttribute('title', title);
      if (content.text !== undefined) b.textContent = content.text;
      if (content.html !== undefined) b.innerHTML = content.html;
      // Never steal focus/selection from the contenteditable.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', onClick);
      return b;
    };

    this.buttons = {
      bold: makeButton('b', t('toolbar.bold'), { text: 'B' }, () => this.onAction('bold')),
      italic: makeButton('i', t('toolbar.italic'), { text: 'I' }, () => this.onAction('italic')),
      code: makeButton('c', t('toolbar.code'), { text: '<>' }, () => this.onAction('code')),
      link: makeButton('l', t('toolbar.link'), { html: LINK_SVG }, () => this.enterLinkMode()),
    };

    this.linkInput = doc.createElement('input');
    this.linkInput.setAttribute('type', 'text');
    this.linkInput.setAttribute('placeholder', t('toolbar.linkPlaceholder'));
    this.linkInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const href = this.linkInput.value.trim();
        this.exitLinkMode();
        if (href) this.onAction('link', href);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.exitLinkMode();
      }
    });

    this.unlinkBtn = makeButton('u', t('toolbar.removeLink'), { html: UNLINK_SVG }, () => {
      this.exitLinkMode();
      this.onAction('unlink');
    });

    this.bar.append(this.buttons.bold, this.buttons.italic, this.buttons.code, this.buttons.link);
    parent.appendChild(this.bar);
  }

  get element(): HTMLElement {
    return this.bar;
  }

  get visible(): boolean {
    return this.bar.classList.contains('visible');
  }

  get linkMode(): boolean {
    return this.inLinkMode;
  }

  /** Position the pill above the selection rect (below when there is no room). */
  show(rect: RectLike, state: ToolbarState): void {
    this.state = state;
    if (!this.inLinkMode) this.renderButtons();
    this.bar.classList.add('visible');

    const width = this.bar.offsetWidth || 124;
    const height = this.bar.offsetHeight || 32;
    const viewportW = this.doc.documentElement.clientWidth || 800;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(6, Math.min(left, viewportW - width - 6));
    let top = rect.top - height - 8;
    if (top < 6) top = rect.bottom + 8;
    this.bar.style.left = `${left}px`;
    this.bar.style.top = `${top}px`;
  }

  hide(): void {
    this.exitLinkMode();
    this.bar.classList.remove('visible');
  }

  /** Second toolbar state: an inline URL input (prefilled inside an <a>) + unlink. */
  private enterLinkMode(): void {
    if (this.inLinkMode) return;
    this.inLinkMode = true;
    this.bar.textContent = '';
    this.linkInput.value = this.state.link ?? '';
    this.bar.appendChild(this.linkInput);
    if (this.state.link !== null) this.bar.appendChild(this.unlinkBtn);
    this.linkInput.focus();
    this.linkInput.select();
  }

  private exitLinkMode(): void {
    if (!this.inLinkMode) return;
    this.inLinkMode = false;
    this.renderButtons();
  }

  private renderButtons(): void {
    this.bar.textContent = '';
    this.bar.append(this.buttons.bold, this.buttons.italic, this.buttons.code, this.buttons.link);
    this.buttons.bold.classList.toggle('active', this.state.bold);
    this.buttons.italic.classList.toggle('active', this.state.italic);
    this.buttons.code.classList.toggle('active', this.state.code);
    this.buttons.link.classList.toggle('active', this.state.link !== null);
  }
}

/**
 * Compute what the toolbar should show for the CURRENT selection, or null
 * when it must hide: no selection, collapsed selection, or a selection not
 * fully inside the session element. Separated from the controller for
 * direct jsdom testing.
 *
 * Bold/italic come from queryCommandState (Chromium tracks the live
 * contenteditable state; absent in jsdom → false); code/link from ancestor
 * checks at the selection's common ancestor.
 */
export function selectionContext(
  win: Window,
  doc: Document,
  sessionEl: HTMLElement,
): { rect: RectLike; state: ToolbarState; range: Range } | null {
  const sel = win.getSelection?.();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!sessionEl.contains(range.startContainer) || !sessionEl.contains(range.endContainer)) {
    return null;
  }

  let rect: RectLike = { left: 0, top: 0, bottom: 0, width: 0 };
  try {
    const r = range.getBoundingClientRect();
    rect = { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
  } catch {
    /* jsdom without Range.getBoundingClientRect — position falls back to 0,0 */
  }

  const qcs = (cmd: string): boolean => {
    try {
      return doc.queryCommandState?.(cmd) ?? false;
    } catch {
      return false;
    }
  };
  const linkEl = closestTag(range.commonAncestorContainer, 'a', sessionEl);
  return {
    rect,
    range,
    state: {
      bold: qcs('bold'),
      italic: qcs('italic'),
      code: closestTag(range.commonAncestorContainer, 'code', sessionEl) !== null,
      link: linkEl ? linkEl.getAttribute('href') : null,
    },
  };
}
