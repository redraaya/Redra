// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeT } from '../../src/shared/i18n.js';
import { SelectionToolbar, selectionContext } from '../../src/preload/editor/toolbar.js';
import type { ToolbarAction } from '../../src/preload/editor/toolbar.js';

/**
 * Markdown quick-toolbar (Stage 5, tier 1): the registry adds the Telegram
 * inline set (underline, strikethrough, spoiler) in md mode, while HTML mode
 * keeps exactly its four buttons (proven by the unchanged toolbar.test.ts).
 */

const t = makeT('ru');
const RECT = { left: 100, top: 200, bottom: 220, width: 80 };
const MD_STATE = {
  bold: false, italic: false, code: false, link: null,
  underline: false, strike: false, spoiler: false,
};

function makeToolbar(format: 'html' | 'md') {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const onAction = vi.fn<(action: ToolbarAction, value?: string) => void>();
  const toolbar = new SelectionToolbar(document, parent, t, onAction, format);
  return { toolbar, onAction };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('quick toolbar: per-format button sets', () => {
  it('HTML mode renders exactly bold, italic, code, link', () => {
    const { toolbar } = makeToolbar('html');
    toolbar.show(RECT, { bold: false, italic: false, code: false, link: null });
    const titles = Array.from(toolbar.element.querySelectorAll('button')).map((b) => b.getAttribute('title'));
    expect(titles).toEqual([t('toolbar.bold'), t('toolbar.italic'), t('toolbar.code'), t('toolbar.link')]);
  });

  it('MD mode adds underline, strikethrough, spoiler', () => {
    const { toolbar } = makeToolbar('md');
    toolbar.show(RECT, MD_STATE);
    const titles = Array.from(toolbar.element.querySelectorAll('button')).map((b) => b.getAttribute('title'));
    expect(titles).toEqual([
      t('toolbar.bold'),
      t('toolbar.italic'),
      t('toolbar.underline'),
      t('toolbar.strikethrough'),
      t('toolbar.spoiler'),
      t('toolbar.code'),
      t('toolbar.link'),
    ]);
  });

  it('MD buttons fire their actions', () => {
    const { toolbar, onAction } = makeToolbar('md');
    toolbar.show(RECT, MD_STATE);
    const byTitle = (title: string): HTMLButtonElement =>
      Array.from(toolbar.element.querySelectorAll('button')).find((b) => b.getAttribute('title') === title)!;
    byTitle(t('toolbar.underline')).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    byTitle(t('toolbar.strikethrough')).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    byTitle(t('toolbar.spoiler')).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['underline', 'strike', 'spoiler']);
  });

  it('active states reflect underline/strike/spoiler', () => {
    const { toolbar } = makeToolbar('md');
    toolbar.show(RECT, { ...MD_STATE, underline: true, spoiler: true });
    const active = Array.from(toolbar.element.querySelectorAll('button.active')).map((b) => b.getAttribute('title'));
    expect(active).toContain(t('toolbar.underline'));
    expect(active).toContain(t('toolbar.spoiler'));
    expect(active).not.toContain(t('toolbar.strikethrough'));
  });
});

describe('selectionContext: new inline states from tag ancestry', () => {
  const setup = (html: string): { win: Window; el: HTMLElement } => {
    document.body.innerHTML = `<div id="s">${html}</div>`;
    return { win: window, el: document.getElementById('s') as HTMLElement };
  };
  const selectInside = (el: HTMLElement, selector: string): void => {
    const target = el.querySelector(selector) ?? el;
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };

  it('spoiler active when the selection sits inside <tg-spoiler>', () => {
    const { win, el } = setup('a <tg-spoiler>secret</tg-spoiler> b');
    selectInside(el, 'tg-spoiler');
    const ctx = selectionContext(win, document, el);
    expect(ctx?.state.spoiler).toBe(true);
  });

  it('strike active inside <s> or <del>', () => {
    const { win, el } = setup('<s>gone</s>');
    selectInside(el, 's');
    expect(selectionContext(win, document, el)?.state.strike).toBe(true);
  });

  it('underline active inside <u>', () => {
    const { win, el } = setup('<u>under</u>');
    selectInside(el, 'u');
    expect(selectionContext(win, document, el)?.state.underline).toBe(true);
  });
});
