// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolveEditable } from '../../src/preload/editor/editable.js';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

const q = (sel: string): Element => document.querySelector(sel)!;

describe('resolveEditable', () => {
  it('click on a stamped <p> edits the <p> itself', () => {
    mount('<p data-redra-id="r5">текст</p>');
    expect(resolveEditable(q('p'))).toBe(q('p'));
  });

  it('click on <b> inside <p> resolves UP to the <p>', () => {
    mount('<p data-redra-id="r5">a <b data-redra-id="r6">b</b></p>');
    expect(resolveEditable(q('b'))).toBe(q('p'));
  });

  it('click on a script-created element (no data-redra-id) → null', () => {
    mount('<div data-redra-id="r4"><p class="generated">из скрипта</p></div>');
    expect(resolveEditable(q('p.generated'))).toBeNull();
  });

  it('click on <td> edits the <td>', () => {
    mount(
      '<table data-redra-id="r3"><tr data-redra-id="r4"><td data-redra-id="r5">x</td></tr></table>',
    );
    expect(resolveEditable(q('td'))).toBe(q('td'));
  });

  it('inline inside a cell resolves to the cell, not the row', () => {
    mount(
      '<table data-redra-id="r3"><tr data-redra-id="r4"><td data-redra-id="r5"><em data-redra-id="r6">x</em></td></tr></table>',
    );
    expect(resolveEditable(q('em'))).toBe(q('td'));
  });

  it('bare inline directly inside a non-editable container edits the outermost inline', () => {
    mount('<div data-redra-id="r3"><span data-redra-id="r4">te<b data-redra-id="r5">x</b>t</span></div>');
    expect(resolveEditable(q('b'))).toBe(q('span'));
    expect(resolveEditable(q('span'))).toBe(q('span'));
  });

  it('non-editable targets (div, figure, img) → null', () => {
    mount(
      '<div data-redra-id="r3"><figure data-redra-id="r4"><img data-redra-id="r5" alt=""></figure></div>',
    );
    expect(resolveEditable(q('div'))).toBeNull();
    expect(resolveEditable(q('figure'))).toBeNull();
    expect(resolveEditable(q('img'))).toBeNull();
  });

  it('an unstamped block wrapper stops the walk at the stamped inline', () => {
    // The <li> wrapper was created by a script: the walk must not escape
    // through it to a stamped ancestor — the stamped <b> itself is edited.
    mount('<div data-redra-id="r2"><li><b data-redra-id="r7">x</b></li></div>');
    expect(resolveEditable(q('b'))).toBe(q('b'));
  });
});

describe('resolveEditable: div-карточки с голым текстом (полевой баг)', () => {
  it('клик в голый текст карточки (target = div) редактирует div', () => {
    mount(
      '<div data-redra-id="r5"><b data-redra-id="r6">Зачем этот документ.</b>' +
        ' Разобраться, как устроен документ.</div>',
    );
    expect(resolveEditable(q('div'))).toBe(q('div'));
  });

  it('клик в <b> внутри текстонесущего div редактирует весь div (одна сессия на карточку)', () => {
    mount(
      '<div data-redra-id="r5"><b data-redra-id="r6">Ключевое наблюдение.</b>' +
        ' M-Video строит себя сразу в трёх слоях.</div>',
    );
    expect(resolveEditable(q('b'))).toBe(q('div'));
  });

  it('div-обёртка без прямого текста остаётся нередактируемой', () => {
    mount(
      '<div data-redra-id="r5"><p data-redra-id="r6">x</p><p data-redra-id="r7">y</p></div>',
    );
    expect(resolveEditable(q('div'))).toBeNull();
  });

  it('пробельный текст между дочерними блоками не делает обёртку редактируемой', () => {
    mount(
      '<div data-redra-id="r5">\n  <p data-redra-id="r6">x</p>\n  <p data-redra-id="r7">y</p>\n</div>',
    );
    expect(resolveEditable(q('div'))).toBeNull();
  });

  it('нештампованный div с текстом (создан скриптом) → null', () => {
    mount('<div><b data-redra-id="r6">з</b> текст</div>');
    expect(resolveEditable(q('div'))).toBeNull();
  });
});
