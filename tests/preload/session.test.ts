// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import {
  beginSession,
  commitSession,
  revertSession,
  isUndoGroupBoundary,
} from '../../src/preload/editor/session.js';

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

  it('commit stubs heavy attr values on stamped elements in the WIRE payload only', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024); // ~3 MB — over the 2 MB editText cap
    const p = mountP(`до <img data-redra-id="r8" src="${big}" alt="img"> после`);
    const s = beginSession(p, normalizeEditedHtml)!;
    p.innerHTML = `ПРАВКА <img data-redra-id="r8" src="${big}" alt="img"> после`;
    const result = commitSession(s, normalizeEditedHtml)!;

    // The op ships without the multi-MB data URI (provenance restores the
    // real attributes from the ops-applied source at save time)…
    expect(result.op.html).toBe('ПРАВКА <img data-redra-id="r8" src="" alt="img"> после');
    // …while the live DOM and the local inverse stack keep the real value.
    expect(p.innerHTML).toContain(big);
    expect(result.newHtml).toContain(big);
  });

  // Word-by-word undo (see isUndoGroupBoundary): break Chromium's typing group
  // on insertion word boundaries only, so each word becomes its own undo step.
  it('breaks the undo group on a typed space and on Enter, not mid-word', () => {
    expect(isUndoGroupBoundary('insertText', ' ')).toBe(true);
    expect(isUndoGroupBoundary('insertParagraph', null)).toBe(true);
    expect(isUndoGroupBoundary('insertLineBreak', null)).toBe(true);

    // mid-word characters keep the group open (so a word undoes as one unit)
    expect(isUndoGroupBoundary('insertText', 'a')).toBe(false);
    expect(isUndoGroupBoundary('insertText', '.')).toBe(false);
    // deletions and IME composition are left untouched
    expect(isUndoGroupBoundary('deleteContentBackward', null)).toBe(false);
    expect(isUndoGroupBoundary('insertCompositionText', ' ')).toBe(false);
    // a pasted chunk containing a space is one unit, not a boundary
    expect(isUndoGroupBoundary('insertFromPaste', 'a b')).toBe(false);
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
