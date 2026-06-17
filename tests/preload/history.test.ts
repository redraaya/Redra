// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalHistory } from '../../src/preload/editor/history.js';

let history: LocalHistory;

beforeEach(() => {
  history = new LocalHistory();
});

const ids = (): string =>
  Array.from(document.body.children)
    .map((el) => el.getAttribute('data-redra-id'))
    .join(',');

describe('LocalHistory — DOM inverse stack', () => {
  it('editText: undo restores prev innerHTML, redo re-applies new', () => {
    document.body.innerHTML = '<p data-redra-id="r3">старый</p>';
    const p = document.querySelector('p')!;
    p.innerHTML = 'новый';
    history.push({ kind: 'editText', el: p as HTMLElement, prevHtml: 'старый', newHtml: 'новый' });

    expect(history.undo()).toBe(true);
    expect(p.innerHTML).toBe('старый');
    expect(history.undo()).toBe(false);

    expect(history.redo()).toBe(true);
    expect(p.innerHTML).toBe('новый');
    expect(history.redo()).toBe(false);
  });

  it('deleteBlock: undo re-inserts the node at its exact position (before a text node)', () => {
    document.body.innerHTML = '<p data-redra-id="r3">a</p>\n<p data-redra-id="r4">b</p>\n';
    const a = document.querySelector('[data-redra-id=r3]')!;
    const parent = a.parentNode as Node & ParentNode;
    const nextSibling = a.nextSibling; // the "\n" text node
    history.push({ kind: 'deleteBlock', node: a, parent, nextSibling });
    a.remove();
    expect(ids()).toBe('r4');

    history.undo();
    expect(ids()).toBe('r3,r4');
    expect(a.nextSibling).toBe(nextSibling); // whitespace untouched

    history.redo();
    expect(ids()).toBe('r4');
    expect(document.contains(a)).toBe(false);
  });

  it('moveBlock: undo returns the node to the old slot, redo re-moves it', () => {
    document.body.innerHTML =
      '<p data-redra-id="r3">a</p><p data-redra-id="r4">b</p><p data-redra-id="r5">c</p>';
    const a = document.querySelector('[data-redra-id=r3]')!;
    const parent = a.parentNode as Node & ParentNode;
    const oldNext = a.nextSibling;
    parent.insertBefore(a, null); // move a to the end
    history.push({ kind: 'moveBlock', node: a, parent, oldNext, newNext: a.nextSibling });
    expect(ids()).toBe('r4,r5,r3');

    history.undo();
    expect(ids()).toBe('r3,r4,r5');

    history.redo();
    expect(ids()).toBe('r4,r5,r3');
  });

  it('setAttr: undo restores the previous value, redo re-applies the new one', () => {
    document.body.innerHTML = '<img data-redra-id="r3" src="old.png">';
    const img = document.querySelector('img')!;
    img.setAttribute('src', 'data:image/png;base64,AA');
    history.push({
      kind: 'setAttr',
      el: img,
      name: 'src',
      prevValue: 'old.png',
      newValue: 'data:image/png;base64,AA',
    });

    expect(history.undo()).toBe(true);
    expect(img.getAttribute('src')).toBe('old.png');

    expect(history.redo()).toBe(true);
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AA');
  });

  it('setAttr with prevValue null: undo REMOVES the attribute', () => {
    document.body.innerHTML = '<img data-redra-id="r3" alt="no src">';
    const img = document.querySelector('img')!;
    img.setAttribute('src', 'new.png');
    history.push({ kind: 'setAttr', el: img, name: 'src', prevValue: null, newValue: 'new.png' });

    history.undo();
    expect(img.hasAttribute('src')).toBe(false);

    history.redo();
    expect(img.getAttribute('src')).toBe('new.png');
  });

  it('undoAndDiscard reverts the DOM and removes the entry entirely (no redo)', () => {
    document.body.innerHTML = '<p data-redra-id="r3">x</p>';
    const p = document.querySelector('p') as HTMLElement;
    history.push({ kind: 'editText', el: p, prevHtml: 'x', newHtml: 'y' });
    p.innerHTML = 'y';

    history.undoAndDiscard();
    expect(p.innerHTML).toBe('x');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false); // dropped, not undone — must not be redoable

    history.undoAndDiscard(); // empty stack: a no-op, never throws
    expect(history.canUndo).toBe(false);
  });

  it('a push after undo discards the redo tail (linear history)', () => {
    document.body.innerHTML = '<p data-redra-id="r3">x</p>';
    const p = document.querySelector('p') as HTMLElement;
    history.push({ kind: 'editText', el: p, prevHtml: 'x', newHtml: 'y' });
    history.undo();
    history.push({ kind: 'editText', el: p, prevHtml: 'x', newHtml: 'z' });
    expect(history.canRedo).toBe(false);
    history.undo();
    expect(history.canUndo).toBe(false);
    expect(p.innerHTML).toBe('x');
  });
});

describe('LocalHistory — discardEntry (a rejected async push rolls back by identity)', () => {
  it('push returns the pushed entry', () => {
    document.body.innerHTML = '<p data-redra-id="r3">x</p>';
    const p = document.querySelector('p') as HTMLElement;
    const e = history.push({ kind: 'editText', el: p, prevHtml: 'x', newHtml: 'y' });
    expect(e.kind).toBe('editText');
  });

  it('drops the RIGHT entry when the rejected one is no longer the newest', () => {
    // setAttr (img1) then editText (p) — img1's push is the OLDER one. Under the
    // async FIFO it can reject AFTER the editText already landed on top; popping
    // the top would wrongly drop the editText. discardEntry must drop img1's.
    document.body.innerHTML = '<img data-redra-id="r3" src="old.png"><p data-redra-id="r4">a</p>';
    const img = document.querySelector('img')!;
    const p = document.querySelector('p') as HTMLElement;
    img.setAttribute('src', 'new.png');
    const imgEntry = history.push({ kind: 'setAttr', el: img, name: 'src', prevValue: 'old.png', newValue: 'new.png' });
    p.innerHTML = 'A';
    history.push({ kind: 'editText', el: p, prevHtml: 'a', newHtml: 'A' });

    history.discardEntry(imgEntry); // img's push rejected
    expect(img.getAttribute('src')).toBe('old.png'); // independent op reverted (bounce)
    expect(p.innerHTML).toBe('A'); // the accepted editText survives untouched
    // exactly one entry (the editText) remains and is undoable
    history.undo();
    expect(p.innerHTML).toBe('a');
    expect(history.canUndo).toBe(false);
  });

  it('a non-newest editText skips the DOM revert (same-block chain safety) but still drops its entry', () => {
    document.body.innerHTML = '<p data-redra-id="r3">a</p><p data-redra-id="r4">b</p>';
    const p1 = document.querySelector('[data-redra-id=r3]') as HTMLElement;
    const p2 = document.querySelector('[data-redra-id=r4]') as HTMLElement;
    p1.innerHTML = 'A';
    const e1 = history.push({ kind: 'editText', el: p1, prevHtml: 'a', newHtml: 'A' });
    p2.innerHTML = 'B';
    history.push({ kind: 'editText', el: p2, prevHtml: 'b', newHtml: 'B' });

    history.discardEntry(e1); // editText, not newest → no DOM revert
    expect(p1.innerHTML).toBe('A'); // left as-is (only reached on stale-doc, DOM moot)
    expect(history.canUndo).toBe(true); // p2's entry remains
    history.undo();
    expect(p2.innerHTML).toBe('b');
    expect(history.canUndo).toBe(false);
  });

  it('discarding a redo-tail entry (already undone mid-session) does not double-revert', () => {
    document.body.innerHTML = '<p data-redra-id="r3">x</p>';
    const p = document.querySelector('p') as HTMLElement;
    p.innerHTML = 'y';
    const entry = history.push({ kind: 'editText', el: p, prevHtml: 'x', newHtml: 'y' });
    history.undo(); // p back to 'x'; entry is now a redo tail (cursor=0)
    expect(history.canRedo).toBe(true);

    history.discardEntry(entry); // its in-flight push then rejected
    expect(p.innerHTML).toBe('x'); // unchanged — not reverted twice
    expect(history.canRedo).toBe(false); // orphan redo entry removed
    expect(history.canUndo).toBe(false);
  });

  it('discardEntry on an entry not in the stack is a no-op', () => {
    document.body.innerHTML = '<p data-redra-id="r3">x</p>';
    const p = document.querySelector('p') as HTMLElement;
    history.push({ kind: 'editText', el: p, prevHtml: 'x', newHtml: 'y' });
    history.discardEntry({ kind: 'editText', el: p, prevHtml: 'q', newHtml: 'q' });
    expect(history.canUndo).toBe(true);
  });
});

describe('LocalHistory — cloneBlock entries', () => {
  it('cloneBlock: undo removes the inserted clone, redo re-inserts it at the exact slot', () => {
    document.body.innerHTML = '<p data-redra-id="r3">a</p>\n<p data-redra-id="r4">b</p>';
    const original = document.querySelector('[data-redra-id=r3]')!;
    original.insertAdjacentHTML('afterend', '<p data-redra-id="c1">a</p>');
    const clone = original.nextElementSibling!;
    const parent = clone.parentNode as Node & ParentNode;
    history.push({ kind: 'cloneBlock', node: clone, parent, nextSibling: clone.nextSibling });
    expect(ids()).toBe('r3,c1,r4');

    expect(history.undo()).toBe(true);
    expect(ids()).toBe('r3,r4');
    expect(document.contains(clone)).toBe(false);

    expect(history.redo()).toBe(true);
    expect(ids()).toBe('r3,c1,r4');
    expect(clone.previousElementSibling).toBe(original);
  });
});
