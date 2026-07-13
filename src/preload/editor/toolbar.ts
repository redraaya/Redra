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

import type { DocFormat, BlockKind } from '../../shared/doc-types.js';

export type ToolbarAction =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'spoiler'
  | 'mark'
  | 'sub'
  | 'sup'
  | 'code'
  | 'link'
  | 'unlink';

/**
 * What the link input's Enter applies: people type «example.com/path» and
 * expect a web link, but as an href it would resolve RELATIVE to the
 * document and 404. A schemeless value whose first segment looks like a
 * hostname (ASCII dot-separated labels, optional :port) gets https://
 * prepended. Everything else stays as typed:
 * - explicit schemes (https:, mailto:, tel:, …);
 * - relative references — «глава-2», #anchor, /abs, ./x, ../y, //host;
 * - local document references: a host-like value ending in .htm/.html
 *   («chapter-2.html») is far more likely a sibling file than a bare TLD;
 * - anything non-ASCII or spaced («глава-2.html») — not a hostname.
 */
export function normalizeLinkInput(raw: string): string {
  const value = raw.trim();
  if (value === '') return value;
  // «host:8080/x» is colon-ambiguous: a digits-only «scheme» followed by a
  // path boundary is a PORT, not a scheme — fall through to the host check.
  const looksLikePort = /^[a-z0-9.-]+:\d+([/?#]|$)/i.test(value);
  if (!looksLikePort && /^[a-z][a-z0-9+.-]*:/i.test(value)) return value; // explicit scheme
  if (/^[/#.]/.test(value)) return value; // absolute / anchor / dot-relative (and //host)
  const host = value.split(/[/?#]/, 1)[0]!;
  if (/\.html?$/i.test(host)) return value; // sibling document, not a TLD
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host)) return value;
  return `https://${value}`;
}

export interface ToolbarState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  /** href of the <a> the selection sits in, or null when not in a link. */
  link: string | null;
  // Markdown-only entities — optional so the HTML path's state literals stay
  // valid unchanged (absent ⇒ inactive).
  underline?: boolean;
  strike?: boolean;
  spoiler?: boolean;
  /** Tag of the block the caret sits in ('h1', 'p', 'pre', …) — md row 2. */
  blockTag?: string;
  /** List membership of the caret's item — md row 2 ('task' = md-task li). */
  listKind?: 'ul' | 'ol' | 'task';
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
.fmtbar .u { text-decoration: underline; text-underline-offset: 2px; }
.fmtbar .s { text-decoration: line-through; }
.fmtbar .sp { filter: blur(1.6px); font-size: 11px; letter-spacing: 0.5px; }
.fmtbar .c { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; }
.fmtbar .sep { width: 1px; height: 16px; margin: 0 3px; background: rgba(28, 27, 25, 0.12); }
@media (prefers-color-scheme: dark) { .fmtbar .sep { background: rgba(236, 234, 230, 0.14); } }
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
.fmtbar .more { width: auto; padding: 0 8px; gap: 3px; font-size: 12px; }
/* MD two-row layout: row 1 = inline formats, row 2 = block types. */
.fmtbar.rows { flex-direction: column; align-items: stretch; padding: 0; }
.fmtbar.rows .frow { display: flex; align-items: center; gap: 2px; padding: 3px; }
.fmtbar.rows .frow + .frow { border-top: 1px solid rgba(28, 27, 25, 0.08); }
@media (prefers-color-scheme: dark) { .fmtbar.rows .frow + .frow { border-top-color: rgba(236, 234, 230, 0.12); } }
.fmtbar button.bk { width: auto; min-width: 26px; padding: 0 6px; font-size: 11px; font-weight: 650; }
.fmtbar button.bq { font-family: Georgia, serif; font-size: 15px; }

/* --- tier-2 "More" panel: cells preview the RESULT, not the syntax --------- */
.fmtpanel {
  position: fixed;
  display: none;
  width: max-content;
  padding: 8px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.99);
  border: 1px solid rgba(28, 27, 25, 0.10);
  box-shadow: 0 10px 34px rgba(20, 18, 14, 0.18);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  z-index: 3;
  user-select: none;
  -webkit-user-select: none;
}
.fmtpanel.visible { display: block; }
.fmtpanel .plabel {
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  color: #a09d95; margin: 6px 6px 6px;
}
.fmtpanel .grid { display: grid; grid-template-columns: repeat(3, minmax(96px, 1fr)); gap: 6px; }
.fmtpanel .cell {
  all: initial; cursor: pointer; text-align: left;
  border: 1px solid rgba(28, 27, 25, 0.09); border-radius: 8px;
  padding: 8px 9px; min-height: 52px;
  display: flex; flex-direction: column; justify-content: center; gap: 3px;
  font-family: inherit;
}
.fmtpanel .cell:hover { border-color: rgba(28, 27, 25, 0.28); }
.fmtpanel .cell .prev { color: #1c1b19; line-height: 1.2; font-family: "Iowan Old Style", Palatino, Georgia, serif; }
.fmtpanel .cell .name { font-size: 10px; color: #8a877f; }
.fmtpanel .prev.h1 { font-family: -apple-system, sans-serif; font-weight: 700; font-size: 17px; letter-spacing: -.02em; }
.fmtpanel .prev.h2 { font-family: -apple-system, sans-serif; font-weight: 650; font-size: 15px; letter-spacing: -.015em; }
.fmtpanel .prev.h3 { font-family: -apple-system, sans-serif; font-weight: 600; font-size: 13px; }
.fmtpanel .prev.body { font-size: 13px; }
.fmtpanel .prev.q { border-left: 2.5px solid #d9d5ca; padding-left: 8px; font-size: 12.5px; }
.fmtpanel .prev.dq .tri { color: #a09d95; font-size: 9px; margin-right: 4px; }
.fmtpanel .prev.code { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; background: rgba(28,27,25,.055); border-radius: 4px; padding: 3px 6px; }
.fmtpanel .prev .m { color: #a09d95; }
.fmtpanel .prev .mk { background: #f6e7a3; border-radius: 3px; padding: 0 3px; }
.fmtpanel .prev.hr i { display: block; height: 1px; background: rgba(28,27,25,.2); }
@media (prefers-color-scheme: dark) {
  .fmtpanel { background: rgba(35, 34, 32, 0.99); border-color: rgba(236, 234, 230, 0.12); }
  .fmtpanel .cell { border-color: rgba(236, 234, 230, 0.12); }
  .fmtpanel .cell:hover { border-color: rgba(236, 234, 230, 0.30); }
  .fmtpanel .cell .prev { color: #eceae6; }
  .fmtpanel .cell .name { color: #8f8c84; }
  .fmtpanel .prev.code { background: rgba(236,234,230,.08); }
  .fmtpanel .prev .mk { background: #57491f; }
}
@media print { .fmtpanel { display: none !important; } }
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

/** One quick-toolbar button. `link` opens the URL input; `more` opens the
 *  tier-2 panel — both are handled locally, not via onAction. */
interface ToolButtonDef {
  id: Exclude<ToolbarAction, 'unlink'> | 'more' | BlockKind;
  cls: string;
  titleKey: Parameters<Translate>[0];
  glyph: { text?: string; html?: string };
  formats: ReadonlySet<DocFormat>;
  active: (s: ToolbarState) => boolean;
  /** A hairline separator is drawn BEFORE this button. */
  sepBefore?: boolean;
  /** md two-row layout: 2 = the block-type row (default 1 = inline row). */
  row?: 1 | 2;
  /** Keyboard shortcut, appended to the tooltip ("Жирный ⌘B"). */
  shortcut?: string;
}

/** Button ids that dispatch through onBlockType (they ARE BlockKind values). */
const BLOCK_KIND_IDS: ReadonlySet<string> = new Set<BlockKind>([
  'paragraph', 'h1', 'h2', 'h3', 'ul', 'ol', 'task', 'blockquote', 'pre', 'hr',
]);

/** A cell in the tier-2 panel: either a block-type change or an inline format,
 *  shown as a VISUAL PREVIEW of the result (never the raw ==syntax==). */
type PanelCell =
  | { block: BlockKind; nameKey: Parameters<Translate>[0]; preview: string }
  | { action: 'mark' | 'sub' | 'sup' | 'spoiler'; nameKey: Parameters<Translate>[0]; preview: string };

interface PanelSection {
  labelKey: Parameters<Translate>[0];
  cells: readonly PanelCell[];
}

const PANEL_SECTIONS: readonly PanelSection[] = [
  // Block types live on the toolbar's second ROW now — the panel keeps only
  // the rare rich-inline extras, one short strip, never a scrollbar.
  {
    labelKey: 'panel.moreFormat',
    cells: [
      { action: 'mark', nameKey: 'panel.highlight', preview: '<span class="prev body"><span class="mk">выделение</span></span>' },
      { action: 'sup', nameKey: 'panel.superscript', preview: '<span class="prev body">x²</span>' },
      { action: 'sub', nameKey: 'panel.subscript', preview: '<span class="prev body">H₂O</span>' },
    ],
  },
];

const BOTH: ReadonlySet<DocFormat> = new Set<DocFormat>(['html', 'md']);
const MD_ONLY: ReadonlySet<DocFormat> = new Set<DocFormat>(['md']);

/**
 * The quick toolbar (tier 1). HTML keeps EXACTLY its four buttons (bold,
 * italic, code, link) so its behaviour is byte-identical; Markdown grows the
 * Telegram inline set (underline, strikethrough, spoiler). The tier-2 "More"
 * panel (block types + rich extras) is added separately.
 */
const TOOL_BUTTONS: readonly ToolButtonDef[] = [
  { id: 'bold', cls: 'b', titleKey: 'toolbar.bold', glyph: { text: 'B' }, formats: BOTH, active: (s) => s.bold, shortcut: '⌘B' },
  { id: 'italic', cls: 'i', titleKey: 'toolbar.italic', glyph: { text: 'I' }, formats: BOTH, active: (s) => s.italic, shortcut: '⌘I' },
  { id: 'underline', cls: 'u', titleKey: 'toolbar.underline', glyph: { text: 'U' }, formats: MD_ONLY, active: (s) => !!s.underline, shortcut: '⌘U' },
  { id: 'strike', cls: 's', titleKey: 'toolbar.strikethrough', glyph: { text: 'S' }, formats: MD_ONLY, active: (s) => !!s.strike, shortcut: '⇧⌘X' },
  { id: 'spoiler', cls: 'sp', titleKey: 'toolbar.spoiler', glyph: { text: 'аб' }, formats: MD_ONLY, active: (s) => !!s.spoiler, shortcut: '⇧⌘P' },
  { id: 'code', cls: 'c', titleKey: 'toolbar.code', glyph: { text: '<>' }, formats: BOTH, active: (s) => s.code, sepBefore: true, shortcut: '⇧⌘M' },
  { id: 'link', cls: 'l', titleKey: 'toolbar.link', glyph: { html: LINK_SVG }, formats: BOTH, active: (s) => s.link !== null },
  // --- md row 2: block types, available IMMEDIATELY (no panel dive) ---------
  { id: 'h1', cls: 'bk', titleKey: 'panel.h1', glyph: { text: 'H1' }, formats: MD_ONLY, active: (s) => s.blockTag === 'h1', row: 2 },
  { id: 'h2', cls: 'bk', titleKey: 'panel.h2', glyph: { text: 'H2' }, formats: MD_ONLY, active: (s) => s.blockTag === 'h2', row: 2 },
  { id: 'h3', cls: 'bk', titleKey: 'panel.h3', glyph: { text: 'H3' }, formats: MD_ONLY, active: (s) => s.blockTag === 'h3', row: 2 },
  { id: 'ul', cls: 'bk', titleKey: 'panel.bullet', glyph: { text: '•' }, formats: MD_ONLY, active: (s) => s.listKind === 'ul', sepBefore: true, row: 2 },
  { id: 'ol', cls: 'bk', titleKey: 'panel.numbered', glyph: { text: '1.' }, formats: MD_ONLY, active: (s) => s.listKind === 'ol', row: 2 },
  { id: 'task', cls: 'bk', titleKey: 'panel.task', glyph: { text: '☑' }, formats: MD_ONLY, active: (s) => s.listKind === 'task', row: 2 },
  { id: 'blockquote', cls: 'bq', titleKey: 'panel.quote', glyph: { text: '❝' }, formats: MD_ONLY, active: (s) => s.blockTag === 'blockquote', sepBefore: true, row: 2 },
  { id: 'pre', cls: 'bk c', titleKey: 'panel.code', glyph: { text: '{ }' }, formats: MD_ONLY, active: (s) => s.blockTag === 'pre', row: 2 },
  { id: 'hr', cls: 'bk', titleKey: 'panel.divider', glyph: { text: '—' }, formats: MD_ONLY, active: () => false, row: 2 },
  { id: 'more', cls: 'more', titleKey: 'panel.more', glyph: {}, formats: MD_ONLY, active: () => false, sepBefore: true, row: 2 },
];

export class SelectionToolbar {
  private readonly bar: HTMLElement;
  /** Rendered buttons for THIS format, with their active-state predicate. */
  private readonly buttons: Array<{ el: HTMLButtonElement; active: (s: ToolbarState) => boolean; sepBefore: boolean; row: number }>;
  private readonly linkInput: HTMLInputElement;
  private readonly unlinkBtn: HTMLButtonElement;
  private readonly doc: Document;
  private state: ToolbarState = {
    bold: false, italic: false, underline: false, strike: false, spoiler: false, code: false, link: null,
  };
  private inLinkMode = false;

  private readonly panel: HTMLElement;

  constructor(
    doc: Document,
    parent: ParentNode,
    t: Translate,
    private readonly onAction: (action: ToolbarAction, value?: string) => void,
    format: DocFormat = 'html',
    private readonly onBlockType: (kind: BlockKind) => void = () => {},
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

    this.buttons = TOOL_BUTTONS.filter((def) => def.formats.has(format)).map((def) => ({
      el: makeButton(
        def.cls,
        def.shortcut ? `${t(def.titleKey)} ${def.shortcut}` : t(def.titleKey),
        // The "More" opener is the one TEXT glyph — localized, never hardcoded.
        def.id === 'more' ? { text: t('panel.moreShort') } : def.glyph,
        () => {
        if (def.id === 'link') this.enterLinkMode();
        else if (def.id === 'more') this.togglePanel();
        else if (BLOCK_KIND_IDS.has(def.id)) this.onBlockType(def.id as BlockKind);
        else this.onAction(def.id as ToolbarAction);
      }),
      active: def.active,
      sepBefore: def.sepBefore ?? false,
      row: def.row ?? 1,
    }));

    // Tier-2 panel (Markdown only): visual-preview cells for block types + rich
    // inline formats. Built once; opened by the "More" button.
    this.panel = doc.createElement('div');
    this.panel.className = 'fmtpanel';
    this.panel.addEventListener('mousedown', (e) => e.preventDefault()); // no focus steal
    if (format === 'md') this.buildPanel(t);
    parent.appendChild(this.panel);

    this.linkInput = doc.createElement('input');
    this.linkInput.setAttribute('type', 'text');
    this.linkInput.setAttribute('placeholder', t('toolbar.linkPlaceholder'));
    this.linkInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const href = normalizeLinkInput(this.linkInput.value);
        this.exitLinkMode();
        if (href) this.onAction('link', href);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.exitLinkMode();
      }
    });

    this.unlinkBtn = makeButton('l', t('toolbar.removeLink'), { html: UNLINK_SVG }, () => {
      this.exitLinkMode();
      this.onAction('unlink');
    });

    this.renderButtons();
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
    this.hidePanel();
    this.bar.classList.remove('visible');
  }

  get panelOpen(): boolean {
    return this.panel.classList.contains('visible');
  }

  /** Build the tier-2 panel cells once (Markdown only). Preview markup is our
   *  own static content; the localized name is set as text. */
  private buildPanel(t: Translate): void {
    for (const section of PANEL_SECTIONS) {
      const label = this.doc.createElement('div');
      label.className = 'plabel';
      label.textContent = t(section.labelKey);
      this.panel.appendChild(label);
      const grid = this.doc.createElement('div');
      grid.className = 'grid';
      for (const cell of section.cells) {
        const btn = this.doc.createElement('button');
        btn.className = 'cell';
        btn.setAttribute('title', t(cell.nameKey));
        btn.innerHTML = cell.preview; // trusted static preview markup
        const name = this.doc.createElement('span');
        name.className = 'name';
        name.textContent = t(cell.nameKey);
        btn.appendChild(name);
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
          this.hidePanel();
          if ('block' in cell) this.onBlockType(cell.block);
          else this.onAction(cell.action);
        });
        grid.appendChild(btn);
      }
      this.panel.appendChild(grid);
    }
  }

  private togglePanel(): void {
    if (this.panelOpen) {
      this.hidePanel();
      return;
    }
    this.panel.classList.add('visible');
    const barRect = this.bar.getBoundingClientRect();
    const w = this.panel.offsetWidth || 300;
    const vw = this.doc.documentElement.clientWidth || 800;
    const left = Math.max(6, Math.min(barRect.left, vw - w - 6));
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${barRect.bottom + 6}px`;
  }

  private hidePanel(): void {
    this.panel.classList.remove('visible');
  }

  /** Second toolbar state: an inline URL input (prefilled inside an <a>) + unlink. */
  private enterLinkMode(): void {
    if (this.inLinkMode) return;
    this.inLinkMode = true;
    this.bar.textContent = '';
    this.bar.classList.remove('rows'); // the URL input is a single-row state
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
    const twoRows = this.buttons.some((b) => b.row === 2);
    this.bar.classList.toggle('rows', twoRows);
    const rowHost = new Map<number, HTMLElement>();
    const hostFor = (row: number): HTMLElement => {
      if (!twoRows) return this.bar;
      let host = rowHost.get(row);
      if (!host) {
        host = this.doc.createElement('div');
        host.className = 'frow';
        rowHost.set(row, host);
        this.bar.appendChild(host);
      }
      return host;
    };
    for (const btn of this.buttons) {
      const host = hostFor(btn.row);
      if (btn.sepBefore) {
        const sep = this.doc.createElement('span');
        sep.className = 'sep';
        host.appendChild(sep);
      }
      btn.el.classList.toggle('active', btn.active(this.state));
      host.appendChild(btn.el);
    }
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
  const anc = range.commonAncestorContainer;
  const linkEl = closestTag(anc, 'a', sessionEl);
  // Row-2 context (md): the block the caret sits in + list membership.
  const ancEl = anc.nodeType === 1 ? (anc as Element) : anc.parentElement;
  const blockEl = ancEl?.closest('h1,h2,h3,h4,h5,h6,p,pre,blockquote') ?? null;
  const blockTag = blockEl && sessionEl.contains(blockEl) ? blockEl.tagName.toLowerCase() : undefined;
  const li = ancEl?.closest('li') ?? null;
  const listEl = li && sessionEl.contains(li) ? li.closest('ul,ol') : null;
  const listKind: 'ul' | 'ol' | 'task' | undefined = listEl
    ? li!.classList.contains('md-task')
      ? 'task'
      : (listEl.tagName.toLowerCase() as 'ul' | 'ol')
    : undefined;
  return {
    rect,
    range,
    state: {
      bold: qcs('bold'),
      italic: qcs('italic'),
      // execCommand state where Chromium tracks it, plus a tag fallback so a
      // <u>/<s>/<tg-spoiler> the selection already sits in reads as active.
      underline: qcs('underline') || closestTag(anc, 'u', sessionEl) !== null,
      strike:
        qcs('strikeThrough') ||
        closestTag(anc, 's', sessionEl) !== null ||
        closestTag(anc, 'del', sessionEl) !== null,
      spoiler: closestTag(anc, 'tg-spoiler', sessionEl) !== null,
      code: closestTag(anc, 'code', sessionEl) !== null,
      link: linkEl ? linkEl.getAttribute('href') : null,
      blockTag,
      listKind,
    },
  };
}
