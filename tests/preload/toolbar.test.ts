// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeT } from '../../src/shared/i18n.js';
import { normalizeLinkInput, SelectionToolbar, selectionContext } from '../../src/preload/editor/toolbar.js';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import type { ToolbarAction } from '../../src/preload/editor/toolbar.js';

const t = makeT('ru');

function makeToolbar() {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const onAction = vi.fn<(action: ToolbarAction, value?: string) => void>();
  const toolbar = new SelectionToolbar(document, parent, t, onAction);
  return { parent, toolbar, onAction };
}

const RECT = { left: 100, top: 200, bottom: 220, width: 80 };
const STATE = { bold: false, italic: false, code: false, link: null };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('SelectionToolbar (DOM)', () => {
  it('starts hidden; show() makes it visible, hide() hides it', () => {
    const { toolbar } = makeToolbar();
    expect(toolbar.visible).toBe(false);
    toolbar.show(RECT, STATE);
    expect(toolbar.visible).toBe(true);
    toolbar.hide();
    expect(toolbar.visible).toBe(false);
  });

  it('reflects the state on the buttons via .active', () => {
    const { toolbar } = makeToolbar();
    toolbar.show(RECT, { bold: true, italic: false, code: true, link: 'https://x.y' });
    const [b, i, c, l] = Array.from(toolbar.element.querySelectorAll('button'));
    expect(b!.classList.contains('active')).toBe(true);
    expect(i!.classList.contains('active')).toBe(false);
    expect(c!.classList.contains('active')).toBe(true);
    expect(l!.classList.contains('active')).toBe(true);
  });

  it('clicking B / I / <> fires the matching action; mousedown is prevented (no focus steal)', () => {
    const { toolbar, onAction } = makeToolbar();
    toolbar.show(RECT, STATE);
    const [b, i, c] = Array.from(toolbar.element.querySelectorAll('button'));

    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    b!.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);

    b!.click();
    i!.click();
    c!.click();
    expect(onAction.mock.calls.map((args) => args[0])).toEqual(['bold', 'italic', 'code']);
  });

  it('link button switches to the input state; Enter applies the href', () => {
    const { toolbar, onAction } = makeToolbar();
    toolbar.show(RECT, STATE);
    const link = toolbar.element.querySelectorAll('button')[3]!;
    link.click();

    expect(toolbar.linkMode).toBe(true);
    const input = toolbar.element.querySelector('input')!;
    expect(input.value).toBe(''); // not inside a link — empty prefill
    input.value = 'https://example.com/';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onAction).toHaveBeenCalledWith('link', 'https://example.com/');
    expect(toolbar.linkMode).toBe(false); // back to the buttons
  });

  it('inside an existing link: prefills the href and offers remove-link', () => {
    const { toolbar, onAction } = makeToolbar();
    toolbar.show(RECT, { ...STATE, link: 'https://old.example/' });
    toolbar.element.querySelectorAll('button')[3]!.click();

    const input = toolbar.element.querySelector('input')!;
    expect(input.value).toBe('https://old.example/');
    const unlink = toolbar.element.querySelector('button')!; // the only button in link mode
    unlink.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toBe('unlink');
    expect(toolbar.linkMode).toBe(false);
  });

  it('Escape leaves link mode without firing an action', () => {
    const { toolbar, onAction } = makeToolbar();
    toolbar.show(RECT, STATE);
    toolbar.element.querySelectorAll('button')[3]!.click();
    const input = toolbar.element.querySelector('input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(toolbar.linkMode).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('empty href on Enter applies nothing', () => {
    const { toolbar, onAction } = makeToolbar();
    toolbar.show(RECT, STATE);
    toolbar.element.querySelectorAll('button')[3]!.click();
    const input = toolbar.element.querySelector('input')!;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('Enter runs the typed value through normalizeLinkInput (example.com → https://)', () => {
    const { toolbar, onAction } = makeToolbar();
    toolbar.show(RECT, STATE);
    toolbar.element.querySelectorAll('button')[3]!.click();
    const input = toolbar.element.querySelector('input')!;
    input.value = 'example.com/path';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onAction).toHaveBeenCalledWith('link', 'https://example.com/path');
  });
});

describe('normalizeLinkInput (schemeless host-like values get https://)', () => {
  it('prepends https:// to host-like values', () => {
    expect(normalizeLinkInput('example.com')).toBe('https://example.com');
    expect(normalizeLinkInput('example.com/path?q=1#frag')).toBe('https://example.com/path?q=1#frag');
    expect(normalizeLinkInput('www.example.com')).toBe('https://www.example.com');
    expect(normalizeLinkInput('sub.domain.co.uk:8080/x')).toBe('https://sub.domain.co.uk:8080/x');
    expect(normalizeLinkInput('  example.com  ')).toBe('https://example.com'); // trimmed
  });

  it('keeps explicit schemes untouched', () => {
    expect(normalizeLinkInput('https://example.com')).toBe('https://example.com');
    expect(normalizeLinkInput('http://example.com')).toBe('http://example.com');
    expect(normalizeLinkInput('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(normalizeLinkInput('tel:+1234')).toBe('tel:+1234');
  });

  it('keeps relative references relative', () => {
    expect(normalizeLinkInput('глава-2')).toBe('глава-2'); // bare word, no dot
    expect(normalizeLinkInput('#section')).toBe('#section');
    expect(normalizeLinkInput('/abs/path')).toBe('/abs/path');
    expect(normalizeLinkInput('./sibling')).toBe('./sibling');
    expect(normalizeLinkInput('../up')).toBe('../up');
    expect(normalizeLinkInput('//proto-relative.example')).toBe('//proto-relative.example');
  });

  it('keeps local html-file references relative despite the dot', () => {
    expect(normalizeLinkInput('chapter-2.html')).toBe('chapter-2.html');
    expect(normalizeLinkInput('notes.htm#top')).toBe('notes.htm#top');
  });

  it('leaves non-host-like dotted values alone (Cyrillic, spaces)', () => {
    expect(normalizeLinkInput('глава-2.html')).toBe('глава-2.html');
    expect(normalizeLinkInput('просто текст. с точкой')).toBe('просто текст. с точкой');
  });
});

describe('selectionContext (show/hide decision)', () => {
  let sessionEl: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML =
      '<p id="s" data-redra-id="rA">внутри <code>код</code> <a href="https://a.b/">ссылка</a></p>' +
      '<p id="out">снаружи</p>';
    sessionEl = document.getElementById('s')!;
  });

  function select(start: Node, startOff: number, end: Node, endOff: number): void {
    const r = document.createRange();
    r.setStart(start, startOff);
    r.setEnd(end, endOff);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }

  it('null without a selection or with a collapsed one', () => {
    window.getSelection()!.removeAllRanges();
    expect(selectionContext(window, document, sessionEl)).toBeNull();
    select(sessionEl.firstChild!, 2, sessionEl.firstChild!, 2); // collapsed
    expect(selectionContext(window, document, sessionEl)).toBeNull();
  });

  it('non-collapsed selection inside the session element → context with a range', () => {
    select(sessionEl.firstChild!, 0, sessionEl.firstChild!, 6);
    const ctx = selectionContext(window, document, sessionEl);
    expect(ctx).not.toBeNull();
    expect(ctx!.range.toString()).toBe('внутри');
    expect(ctx!.state.code).toBe(false);
    expect(ctx!.state.link).toBeNull();
  });

  it('null when the selection leaves the session element', () => {
    const out = document.getElementById('out')!;
    select(sessionEl.firstChild!, 0, out.firstChild!, 3);
    expect(selectionContext(window, document, sessionEl)).toBeNull();
  });

  it('detects code and link ancestors for the state', () => {
    const codeText = sessionEl.querySelector('code')!.firstChild!;
    select(codeText, 0, codeText, 3);
    expect(selectionContext(window, document, sessionEl)!.state.code).toBe(true);

    const linkText = sessionEl.querySelector('a')!.firstChild!;
    select(linkText, 0, linkText, 6);
    const ctx = selectionContext(window, document, sessionEl)!;
    expect(ctx.state.link).toBe('https://a.b/');
    expect(ctx.state.code).toBe(false);
  });
});

describe('toolbar output flows through the commit pipeline (normalize)', () => {
  it('b/i/code/a markup produced by the toolbar survives normalizeEditedHtml bare', () => {
    expect(normalizeEditedHtml('до <b>жирный</b> после')).toBe('до <b>жирный</b> после');
    expect(normalizeEditedHtml('<i style="x:y">курсив</i>')).toBe('<i>курсив</i>');
    expect(normalizeEditedHtml('т <code>код</code>')).toBe('т <code>код</code>');
    expect(normalizeEditedHtml('<a href="https://example.com/">с</a>')).toBe(
      '<a href="https://example.com/">с</a>',
    );
  });

  it('execCommand-style junk attributes are stripped, unsafe hrefs dropped', () => {
    expect(normalizeEditedHtml('<b class="x" data-q="1">ж</b>')).toBe('<b>ж</b>');
    expect(normalizeEditedHtml('<a href="javascript:alert(1)">с</a>')).toBe('<a>с</a>');
  });
});
