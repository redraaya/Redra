// @vitest-environment jsdom
//
// Click-pinned handle (field bug: row layouts). Hovering a block shows the
// pill to its LEFT — but when blocks sit in a row, the trip to the pill
// crosses a SIBLING block, which used to steal the hover and hide the pill.
// Fix: a CLICK on a block pins the pill; hover no longer moves it. The pin
// drops on a click over empty space / another block, on Escape, or when a
// text session takes over.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

function makeBridge() {
  return {
    pushOp: vi.fn(async () => ({ ok: true as const })),
    cloneBlock: vi.fn(async () => ({ ok: true as const, cloneId: 'c1', html: '<p data-redra-id="c1">x</p>' })),
    undo: vi.fn(async () => ({ ok: true, dirty: false })),
    redo: vi.fn(async () => ({ ok: true, dirty: false })),
    openExternal: vi.fn(),
    pickImage: vi.fn(async () => ({ ok: true as const, value: 'x' })),
    replaceImageFromPath: vi.fn(async () => ({ ok: true as const, value: 'x' })),
    pathForFile: vi.fn(() => '/tmp/x.png'),
    notifyRejected: vi.fn(),
    emitAvailability: vi.fn(),
  } satisfies RedraDocBridge;
}

const click = (el: Element) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const hover = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

describe('click pins the block handle (row layouts)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;
  let shadowRoots: ShadowRoot[];

  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const handle = (): HTMLElement => {
    for (const root of shadowRoots) {
      const h = root.querySelector('.handle');
      if (h) return h as HTMLElement;
    }
    throw new Error('handle pill not found in any captured shadow root');
  };
  const handleVisible = () => handle().classList.contains('visible');
  const washed = (id: string) => el(id).classList.contains('redra-hover');

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    shadowRoots = [];
    const original = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      const root = original.call(this, init);
      shadowRoots.push(root);
      return root;
    });
    // Two "cards" side by side (row layout) with NON-editable insides
    // (<canvas> has no text and is not an editable tag), plus a text block
    // and a bare no-id canvas standing in for empty space.
    document.body.innerHTML =
      '<div data-redra-id="rA" id="a"><canvas data-redra-id="rA1" id="ac"></canvas></div>' +
      '<div data-redra-id="rB" id="b"><canvas data-redra-id="rB1" id="bc"></canvas></div>' +
      '<p data-redra-id="rT" id="t">текст</p>' +
      '<canvas id="bare"></canvas>';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });

  afterEach(() => {
    controller.destroy();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('click on a non-editable block pins the pill; hovering a sibling no longer steals it', () => {
    click(el('ac')); // non-editable → pin card A
    expect(el('ac').hasAttribute('contenteditable')).toBe(false); // no session
    expect(handleVisible()).toBe(true);
    expect(washed('a')).toBe(true);

    hover(el('bc')); // the pointer crosses the neighbouring card on its way to the pill
    expect(washed('a')).toBe(true); // pin holds — THE row-layout bug
    expect(washed('b')).toBe(false);
    expect(handleVisible()).toBe(true);

    // Leaving the window doesn't drop the pin either.
    el('a').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(handleVisible()).toBe(true);
  });

  it('click on another block re-pins; click on empty space unpins', () => {
    click(el('ac'));
    expect(washed('a')).toBe(true);

    click(el('bc')); // re-pin to card B
    expect(washed('b')).toBe(true);
    expect(washed('a')).toBe(false);
    expect(handleVisible()).toBe(true);

    click(el('bare')); // empty space → unpin
    expect(washed('a')).toBe(false);
    expect(washed('b')).toBe(false);
    expect(handleVisible()).toBe(false);

    // Hover mode is back to normal after the unpin.
    hover(el('ac'));
    expect(washed('a')).toBe(true);
  });

  it('Escape drops the pin', () => {
    click(el('ac'));
    expect(handleVisible()).toBe(true);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(handleVisible()).toBe(false);
    expect(washed('a')).toBe(false);
  });

  it('clicking into text supersedes the pin with a session; committing restores hover mode', () => {
    click(el('ac')); // pin card A
    click(el('t')); // text block → session takes over
    expect(el('t').getAttribute('contenteditable')).toBe('true');
    expect(handleVisible()).toBe(true); // session anchors the handle to <p>

    click(el('bare')); // commit; the old pin must NOT resurrect
    expect(el('t').hasAttribute('contenteditable')).toBe(false);
    expect(handleVisible()).toBe(false);
    expect(washed('a')).toBe(false);
  });

  it('committing a session by clicking another block pins that block', async () => {
    click(el('t')); // session on the text block
    el('t').innerHTML = 'текст!';
    click(el('ac')); // click a card: commits the session AND pins the card
    expect(el('t').hasAttribute('contenteditable')).toBe(false);
    expect(washed('a')).toBe(true);
    expect(handleVisible()).toBe(true);
    // The committed edit reached the journal (via the FIFO — a tick later).
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(bridge.pushOp).toHaveBeenCalledWith({ type: 'editText', id: 'rT', html: 'текст!' });
  });

  it('deleting the pinned block via the pill clears the pin', () => {
    click(el('ac'));
    const trash = (() => {
      for (const root of shadowRoots) {
        const t = root.querySelector('.trash');
        if (t) return t as HTMLElement;
      }
      throw new Error('trash button not found');
    })();
    trash.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('a')).toBeNull(); // block gone
    expect(handleVisible()).toBe(false);
    // Hover works normally afterwards.
    hover(el('bc'));
    expect(washed('b')).toBe(true);
  });
});
