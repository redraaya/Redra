// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { beginSession, commitSession, revertSession } from '../../src/preload/editor/session.js';

function mountP(inner: string): HTMLElement {
  document.body.innerHTML = `<p data-redra-id="r5">${inner}</p>`;
  return document.querySelector('p')!;
}

describe('edit session commit pipeline', () => {
  it('begin marks the element editable, captures the original', () => {
    const p = mountP('привет <b data-redra-id="r6">мир</b>');
    const s = beginSession(p, normalizeEditedHtml)!;
    expect(p.getAttribute('contenteditable')).toBe('true');
    expect(p.classList.contains('redra-editing-el')).toBe(true);
    expect(s.id).toBe('r5');
    expect(s.originalHtml).toBe('привет <b data-redra-id="r6">мир</b>');
  });

  it('refuses elements without data-redra-id', () => {
    document.body.innerHTML = '<p>голый</p>';
    expect(beginSession(document.querySelector('p')!, normalizeEditedHtml)).toBeNull();
  });

  it('commit normalizes the stamped innerHTML into the op payload (stamps stay — applyOps verifies them)', () => {
    const p = mountP('привет <b data-redra-id="r6">мир</b>');
    const s = beginSession(p, normalizeEditedHtml)!;
    p.innerHTML = 'привет <b data-redra-id="r6">всем</b><span style="color:red"> !</span>';
    const result = commitSession(s, normalizeEditedHtml)!;
    expect(result.op).toEqual({
      type: 'editText',
      id: 'r5',
      html: 'привет <b data-redra-id="r6">всем</b> !',
    });
    // live DOM stays exactly as the user left it (stamps and all)
    expect(p.innerHTML).toBe(
      'привет <b data-redra-id="r6">всем</b><span style="color:red"> !</span>',
    );
    expect(p.hasAttribute('contenteditable')).toBe(false);
    expect(p.classList.contains('redra-editing-el')).toBe(false);
  });

  it('unchanged content (after normalization) commits to nothing', () => {
    const p = mountP('привет <b data-redra-id="r6">мир</b>');
    const s = beginSession(p, normalizeEditedHtml)!;
    // contenteditable-style noise that normalization cancels out
    p.innerHTML = 'привет <b data-redra-id="r6"><span>мир</span></b>';
    expect(commitSession(s, normalizeEditedHtml)).toBeNull();
    expect(p.hasAttribute('contenteditable')).toBe(false);
  });

  it('Escape revert restores the EXACT pre-session innerHTML', () => {
    const original = 'привет <b data-redra-id="r6">мир</b> <!--c--> хвост';
    const p = mountP(original);
    const s = beginSession(p, normalizeEditedHtml)!;
    p.innerHTML = 'всё переписано';
    revertSession(s);
    expect(p.innerHTML).toBe(original);
    expect(p.hasAttribute('contenteditable')).toBe(false);
    expect(p.hasAttribute('class')).toBe(false); // no leftover empty class
  });
});
