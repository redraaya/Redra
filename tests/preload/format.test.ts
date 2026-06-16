// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { closestTag, computeInlineToggle, toggleInlineTag } from '../../src/preload/editor/format.js';

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<p id="host" data-redra-id="rA"></p>';
  host = document.getElementById('host')!;
});

function rangeOver(start: Node, startOff: number, end: Node, endOff: number): Range {
  const r = document.createRange();
  r.setStart(start, startOff);
  r.setEnd(end, endOff);
  return r;
}

describe('closestTag', () => {
  it('finds the nearest matching ancestor, stopping before the boundary', () => {
    host.innerHTML = '<code id="c">text <b id="b">bold</b></code>';
    const b = document.getElementById('b')!;
    expect(closestTag(b.firstChild, 'code', host)?.id).toBe('c');
    expect(closestTag(b.firstChild, 'b', host)?.id).toBe('b');
    expect(closestTag(b.firstChild, 'a', host)).toBeNull();
  });

  it('never returns the boundary itself even when the tag matches', () => {
    document.body.innerHTML = '<code id="outer"><span id="s">x</span></code>';
    const s = document.getElementById('s')!;
    expect(closestTag(s.firstChild, 'code', document.getElementById('outer')!)).toBeNull();
  });
});

describe('toggleInlineTag — wrap', () => {
  it('wraps a plain text selection in the tag and reselects its contents', () => {
    host.textContent = 'hello world';
    const text = host.firstChild!;
    const range = rangeOver(text, 6, text, 11);

    expect(toggleInlineTag(range, 'code', host)).toBe('wrapped');
    expect(host.innerHTML).toBe('hello <code>world</code>');
    expect(range.toString()).toBe('world'); // selection survives for the toolbar
  });

  it('wraps a selection spanning inline elements', () => {
    host.innerHTML = 'aa <b>bb</b> cc';
    const range = document.createRange();
    range.setStart(host.firstChild!, 0); // 'aa '
    range.setEnd(host.lastChild!, 3); // ' cc'

    toggleInlineTag(range, 'code', host);
    expect(host.innerHTML).toBe('<code>aa <b>bb</b> cc</code>');
  });

  it('dissolves nested same-tag wrappers instead of double-wrapping', () => {
    host.innerHTML = 'xx <code>yy</code> zz';
    const range = document.createRange();
    range.setStart(host.firstChild!, 0);
    range.setEnd(host.lastChild!, 3);

    toggleInlineTag(range, 'code', host);
    expect(host.innerHTML).toBe('<code>xx yy zz</code>');
  });

  it('partial overlap with an existing tag extends the formatting (split-and-rewrap)', () => {
    host.innerHTML = '<code id="c">abcdef</code> tail';
    const codeText = document.getElementById('c')!.firstChild!;
    const range = document.createRange();
    range.setStart(codeText, 3); // 'def' inside code…
    range.setEnd(host.lastChild!, 5); // …plus ' tail' outside

    // commonAncestorContainer is the host → wrap path, not unwrap.
    expect(toggleInlineTag(range, 'code', host)).toBe('wrapped');
    expect(host.querySelectorAll('code')).toHaveLength(2);
    expect(host.textContent).toBe('abcdef tail');
    // No nested code anywhere.
    expect(host.querySelector('code code')).toBeNull();
  });
});

describe('toggleInlineTag — unwrap', () => {
  it('unwraps when the selection is entirely inside the tag', () => {
    host.innerHTML = 'aa <code id="c">bb cc</code> dd';
    const codeText = document.getElementById('c')!.firstChild!;
    const range = rangeOver(codeText, 0, codeText, 5);

    expect(toggleInlineTag(range, 'code', host)).toBe('unwrapped');
    expect(host.innerHTML).toBe('aa bb cc dd');
  });

  it('unwraps the WHOLE element even for a partial inner selection (toggle off)', () => {
    host.innerHTML = '<code id="c">one two three</code>';
    const codeText = document.getElementById('c')!.firstChild!;
    const range = rangeOver(codeText, 4, codeText, 7); // just 'two'

    toggleInlineTag(range, 'code', host);
    expect(host.innerHTML).toBe('one two three');
  });

  it('round-trips: wrap then unwrap restores the text content', () => {
    host.textContent = 'roundtrip';
    const text = host.firstChild!;
    const range = rangeOver(text, 0, text, 9);

    toggleInlineTag(range, 'code', host);
    expect(host.querySelector('code')).not.toBeNull();
    toggleInlineTag(range, 'code', host);
    expect(host.querySelector('code')).toBeNull();
    expect(host.textContent).toBe('roundtrip');
  });
});

/**
 * computeInlineToggle is the pure transform that feeds the native-undo path:
 * it produces the HTML to hand to a single document.execCommand('insertHTML')
 * plus the range to select first, WITHOUT mutating the live DOM. These tests
 * assert that transform deterministically (jsdom has no execCommand, so the
 * actual insertHTML + native ⌘Z is verified manually in the real app — see
 * the report). The produced html for the wrap case must match what the old
 * direct-mutation toggleInlineTag wrote, and the unwrap plan must select the
 * WHOLE existing element so insertHTML of its inner html drops the wrapper.
 */
describe('computeInlineToggle — pure transform (native-undo path)', () => {
  it('does not mutate the live DOM (it only computes a plan)', () => {
    host.textContent = 'hello world';
    const text = host.firstChild!;
    const range = rangeOver(text, 6, text, 11);

    computeInlineToggle(range, 'code', host);
    expect(host.innerHTML).toBe('hello world'); // untouched
  });

  it('wrap: plan selects the user range and inserts the wrapped html', () => {
    host.textContent = 'hello world';
    const text = host.firstChild!;
    const range = rangeOver(text, 6, text, 11);

    const plan = computeInlineToggle(range, 'code', host);
    expect(plan.mode).toBe('wrapped');
    expect(plan.html).toBe('<code>world</code>');
    expect(plan.selectRange).toBe(range); // wrap replaces the user's selection
  });

  it('wrap: dissolves nested same-tags inside the produced html (no <code><code>)', () => {
    host.innerHTML = 'xx <code>yy</code> zz';
    const range = document.createRange();
    range.setStart(host.firstChild!, 0);
    range.setEnd(host.lastChild!, 3);

    const plan = computeInlineToggle(range, 'code', host);
    expect(plan.mode).toBe('wrapped');
    expect(plan.html).toBe('<code>xx yy zz</code>');
  });

  it('wrap: keeps other inline elements inside the produced html', () => {
    host.innerHTML = 'aa <b>bb</b> cc';
    const range = document.createRange();
    range.setStart(host.firstChild!, 0);
    range.setEnd(host.lastChild!, 3);

    const plan = computeInlineToggle(range, 'code', host);
    expect(plan.html).toBe('<code>aa <b>bb</b> cc</code>');
  });

  it('unwrap: plan selects the WHOLE element and inserts its inner html (wrapper gone)', () => {
    host.innerHTML = '<code id="c">one two three</code>';
    const code = document.getElementById('c')!;
    const codeText = code.firstChild!;
    const range = rangeOver(codeText, 4, codeText, 7); // just 'two' — partial

    const plan = computeInlineToggle(range, 'code', host);
    expect(plan.mode).toBe('unwrapped');
    expect(plan.html).toBe('one two three'); // the wrapper's contents, no <code>
    // The select-range spans the entire <code> element, so an insertHTML of
    // plan.html replaces the whole wrapper — "toggle off the whole element".
    expect(plan.selectRange.toString()).toBe('one two three');
  });

  it('the plan, applied by hand, matches the direct-mutation toggleInlineTag', () => {
    // Mirror the real controller: select plan.selectRange, then replace its
    // contents with plan.html. The result must equal what toggleInlineTag
    // produces by direct surgery — proving the native path is behaviour-equal.
    const apply = (start: string): string => {
      document.body.innerHTML = `<p id="h">${start}</p>`;
      const h = document.getElementById('h')!;
      const r = document.createRange();
      r.setStart(h.firstChild!, 0);
      r.setEnd(h.lastChild!, (h.lastChild as Text).length ?? 0);
      // Select the FULL paragraph contents for a clean comparison.
      r.selectNodeContents(h);
      const plan = computeInlineToggle(r, 'code', h);
      // Emulate insertHTML(plan.html) over plan.selectRange:
      plan.selectRange.deleteContents();
      const frag = r.createContextualFragment(plan.html);
      plan.selectRange.insertNode(frag);
      return h.innerHTML;
    };
    const direct = (start: string): string => {
      document.body.innerHTML = `<p id="h">${start}</p>`;
      const h = document.getElementById('h')!;
      const r = document.createRange();
      r.selectNodeContents(h);
      toggleInlineTag(r, 'code', h);
      return h.innerHTML;
    };
    for (const start of ['hello world', '<code>already code</code>', 'a <b>b</b> c']) {
      expect(apply(start)).toBe(direct(start));
    }
  });
});
