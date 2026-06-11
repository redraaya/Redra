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
