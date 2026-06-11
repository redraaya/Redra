// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolveBlock } from '../../src/preload/editor/blocks.js';

const q = (sel: string): Element => document.querySelector(sel)!;
const resolve = (el: Element): HTMLElement | null => resolveBlock(el, window);

describe('resolveBlock — the four layout shapes from the spec', () => {
  it('flat report: p/h2/table as direct children of body', () => {
    document.body.innerHTML = `
      <h2 data-redra-id="r3">Заголовок</h2>
      <p data-redra-id="r4">Абзац <strong data-redra-id="r5">жирный</strong></p>
      <table data-redra-id="r6"><tbody data-redra-id="r7">
        <tr data-redra-id="r8"><td data-redra-id="r9">x</td></tr>
      </tbody></table>`;
    expect(resolve(q('p'))).toBe(q('p'));
    expect(resolve(q('h2'))).toBe(q('h2'));
    expect(resolve(q('strong'))).toBe(q('p')); // inline hoists to its block
    expect(resolve(q('td'))).toBe(q('table')); // cells/rows are not blocks
  });

  it('nested layout: div.container > section > content', () => {
    document.body.innerHTML = `
      <div class="container" data-redra-id="r3">
        <section data-redra-id="r4">
          <h2 data-redra-id="r5">A</h2>
          <p data-redra-id="r6">B</p>
          <p data-redra-id="r7">C</p>
        </section>
        <section data-redra-id="r8"><p data-redra-id="r9">D</p></section>
      </div>`;
    expect(resolve(q('[data-redra-id=r6]'))).toBe(q('[data-redra-id=r6]'));
    expect(resolve(q('h2'))).toBe(q('h2'));
    // Hovering a section directly: it sits among sibling sections.
    expect(resolve(q('[data-redra-id=r4]'))).toBe(q('[data-redra-id=r4]'));
  });

  it('presentation: body > div.slide > h1+p', () => {
    document.body.innerHTML = `
      <div class="slide" data-redra-id="r3">
        <h1 data-redra-id="r4">Слайд 1</h1>
        <p data-redra-id="r5">Текст</p>
      </div>
      <div class="slide" data-redra-id="r6"><h1 data-redra-id="r7">Слайд 2</h1></div>`;
    expect(resolve(q('h1'))).toBe(q('h1'));
    expect(resolve(q('[data-redra-id=r5]'))).toBe(q('[data-redra-id=r5]'));
    expect(resolve(q('.slide'))).toBe(q('.slide')); // the slide itself, child of body
  });

  it('single-root page: body > #app > everything — blocks are #app children and deeper', () => {
    document.body.innerHTML = `
      <div id="app" data-redra-id="r3">
        <header data-redra-id="r4"><h1 data-redra-id="r5">Шапка</h1></header>
        <div class="content" data-redra-id="r6">
          <p data-redra-id="r7">Один</p>
          <p data-redra-id="r8">Два</p>
        </div>
      </div>`;
    expect(resolve(q('[data-redra-id=r7]'))).toBe(q('[data-redra-id=r7]'));
    expect(resolve(q('header'))).toBe(q('header'));
    // h1 is the sole child of header → not a unit among peers; header is.
    expect(resolve(q('h1'))).toBe(q('header'));
    expect(resolve(q('#app'))).toBe(q('#app')); // direct child of body
  });

  it('script-created elements (no data-redra-id) are never blocks themselves', () => {
    document.body.innerHTML = `
      <div data-redra-id="r3"><p data-redra-id="r4">a</p><p data-redra-id="r5">b</p></div>`;
    const injected = document.createElement('p');
    injected.textContent = 'из скрипта';
    q('[data-redra-id=r3]').appendChild(injected);
    // Hovering the injected p falls through to a stamped ancestor block.
    expect(resolve(injected)).toBe(q('[data-redra-id=r3]'));
  });

  it('hovering body/html yields nothing', () => {
    document.body.innerHTML = '<p data-redra-id="r3">x</p>';
    expect(resolve(document.body)).toBeNull();
    expect(resolve(document.documentElement)).toBeNull();
  });
});
