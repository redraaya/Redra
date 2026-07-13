/**
 * Slash menu (MD 2.0): type "/" in an EMPTY block and pick what the next
 * text becomes — Notion's pattern, in Redra's quiet dress. Pure overlay
 * chrome like SelectionToolbar: renders into any parent (the controller's
 * closed shadow root; tests mount a plain div), reports the pick through one
 * callback, owns zero editing logic.
 *
 * Keyboard contract while open (the controller routes keydown here first):
 * ↑/↓ move, Enter applies, Escape closes, letters/Backspace filter by the
 * localized name, anything else closes (the keystroke then acts normally).
 */
import type { Translate } from '../../shared/i18n.js';
import type { BlockKind } from '../../shared/doc-types.js';

export const SLASH_CSS = `
.slashmenu {
  position: fixed;
  display: none;
  min-width: 230px;
  padding: 5px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.99);
  border: 1px solid rgba(28, 27, 25, 0.10);
  box-shadow: 0 10px 34px rgba(20, 18, 14, 0.18);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  z-index: 4;
  user-select: none;
  -webkit-user-select: none;
}
.slashmenu.visible { display: block; }
.slashmenu .row {
  all: initial;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 9px;
  border-radius: 7px;
  cursor: pointer;
  font-family: inherit;
}
.slashmenu .row.active { background: rgba(28, 27, 25, 0.07); }
.slashmenu .glyph {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 26px; flex: none;
  border: 1px solid rgba(28, 27, 25, 0.10); border-radius: 6px;
  font-size: 11px; font-weight: 650; color: #6f6c64;
  font-family: inherit;
}
.slashmenu .label { font-size: 12.5px; color: #1c1b19; }
.slashmenu .empty { padding: 8px 10px; font-size: 12px; color: #a09d95; font-family: inherit; }
@media (prefers-color-scheme: dark) {
  .slashmenu { background: rgba(35, 34, 32, 0.99); border-color: rgba(236, 234, 230, 0.12); }
  .slashmenu .row.active { background: rgba(236, 234, 230, 0.10); }
  .slashmenu .glyph { border-color: rgba(236, 234, 230, 0.14); color: #8f8c84; }
  .slashmenu .label { color: #eceae6; }
}
@media print { .slashmenu { display: none !important; } }
`;

interface SlashItem {
  kind: BlockKind;
  nameKey: Parameters<Translate>[0];
  glyph: string;
}

const ITEMS: readonly SlashItem[] = [
  { kind: 'h1', nameKey: 'panel.h1', glyph: 'H1' },
  { kind: 'h2', nameKey: 'panel.h2', glyph: 'H2' },
  { kind: 'h3', nameKey: 'panel.h3', glyph: 'H3' },
  { kind: 'paragraph', nameKey: 'panel.text', glyph: 'Aa' },
  { kind: 'ul', nameKey: 'panel.bullet', glyph: '•' },
  { kind: 'ol', nameKey: 'panel.numbered', glyph: '1.' },
  { kind: 'task', nameKey: 'panel.task', glyph: '☑' },
  { kind: 'blockquote', nameKey: 'panel.quote', glyph: '❝' },
  { kind: 'pre', nameKey: 'panel.code', glyph: '{ }' },
  { kind: 'hr', nameKey: 'panel.divider', glyph: '—' },
];

export class SlashMenu {
  private readonly host: HTMLElement;
  private readonly doc: Document;
  private readonly names: Array<{ item: SlashItem; name: string }>;
  private query = '';
  private active = 0;
  private matches: SlashItem[] = [];

  constructor(
    doc: Document,
    parent: ParentNode,
    t: Translate,
    private readonly onPick: (kind: BlockKind) => void,
  ) {
    this.doc = doc;
    this.host = doc.createElement('div');
    this.host.className = 'slashmenu';
    this.host.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret
    parent.appendChild(this.host);
    this.names = ITEMS.map((item) => ({ item, name: t(item.nameKey) }));
  }

  get visible(): boolean {
    return this.host.classList.contains('visible');
  }

  open(anchor: { left: number; bottom: number; top: number }): void {
    this.query = '';
    this.active = 0;
    this.render();
    this.host.classList.add('visible');
    const h = this.host.offsetHeight || 300;
    const vh = this.doc.documentElement.clientHeight || 600;
    const top = anchor.bottom + 6 + h > vh ? Math.max(6, anchor.top - h - 6) : anchor.bottom + 6;
    this.host.style.left = `${Math.max(6, anchor.left)}px`;
    this.host.style.top = `${top}px`;
  }

  close(): void {
    this.host.classList.remove('visible');
  }

  /**
   * Route a keydown while open. Returns TRUE when the key was consumed (the
   * controller then prevents the default edit). An unhandled key closes the
   * menu and returns false so the keystroke acts normally.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.close();
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = this.matches.length;
      if (n > 0) {
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.render();
      }
      return true;
    }
    if (e.key === 'Enter') {
      const pick = this.matches[this.active];
      this.close();
      if (pick) this.onPick(pick.kind);
      return true;
    }
    if (e.key === 'Backspace') {
      if (this.query === '') {
        this.close(); // erased past the slash — back to plain typing
        return true;
      }
      this.query = this.query.slice(0, -1);
      this.active = 0;
      this.render();
      return true;
    }
    if (e.key.length === 1 && /[\p{L}\p{N}]/u.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.query += e.key.toLowerCase();
      this.active = 0;
      this.render();
      return true;
    }
    // Space, arrows sideways, shortcuts… — not ours: close and let it act.
    this.close();
    return false;
  }

  private render(): void {
    this.matches = this.names
      .filter(({ name }) => name.toLowerCase().includes(this.query))
      .map(({ item }) => item);
    this.host.textContent = '';
    if (this.matches.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'empty';
      empty.textContent = `/${this.query}`;
      this.host.appendChild(empty);
      return;
    }
    this.matches.forEach((item, i) => {
      const row = this.doc.createElement('button');
      row.className = i === this.active ? 'row active' : 'row';
      const glyph = this.doc.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = item.glyph;
      const label = this.doc.createElement('span');
      label.className = 'label';
      label.textContent = this.names.find((n) => n.item === item)!.name;
      row.append(glyph, label);
      row.addEventListener('click', () => {
        this.close();
        this.onPick(item.kind);
      });
      this.host.appendChild(row);
    });
  }
}
