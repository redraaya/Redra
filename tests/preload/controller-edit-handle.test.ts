// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * Handle-during-edit (v0.4.0): when a text edit session opens on a block, the
 * overlay handle pill stays anchored to that block so duplicate/trash remain
 * reachable mid-edit. Trash discards the in-progress edit before deleting;
 * duplicate commits the typed text first so the clone includes it. Ending the
 * session (Esc/blur) restores normal hover behaviour.
 *
 * The overlay lives in a CLOSED shadow root — tests capture it from
 * Element.prototype.attachShadow (same trick as controller-clone.test.ts).
 */

function makeBridge() {
  return {
    pushOp: vi.fn(async () => ({ ok: true as const })),
    cloneBlock: vi.fn(async () => ({
      ok: true as const,
      cloneId: 'c1',
      html: '<p data-redra-id="c1">x</p>',
    })),
    undo: vi.fn(async () => ({ ok: true, dirty: false })),
    redo: vi.fn(async () => ({ ok: true, dirty: false })),
    openExternal: vi.fn(),
    pickImage: vi.fn(async () => ({ ok: true as const, value: 'data:image/png;base64,AA' })),
    replaceImageFromPath: vi.fn(async () => ({ ok: true as const, value: 'data:image/png;base64,BB' })),
    pathForFile: vi.fn(() => '/tmp/dropped.png'),
    notifyRejected: vi.fn(),
    emitAvailability: vi.fn(),
  } satisfies RedraDocBridge;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function click(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

describe('handle stays anchored during an edit session (jsdom)', () => {
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
    document.body.innerHTML =
      '<p data-redra-id="rA" id="a">привет мир</p>' +
      '<h2 data-redra-id="rB" id="b">заголовок</h2>';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });

  afterEach(() => {
    controller.destroy();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows the handle for the session element when a session starts', () => {
    expect(handle().classList.contains('visible')).toBe(false); // dormant at rest
    click(el('a')); // opens a session on <p id=a>
    expect(el('a').getAttribute('contenteditable')).toBe('true');
    expect(handle().classList.contains('visible')).toBe(true);
  });

  it('hides the handle again when the session ends (Escape restores hover)', () => {
    click(el('a'));
    expect(handle().classList.contains('visible')).toBe(true);
    el('a').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(el('a').hasAttribute('contenteditable')).toBe(false);
    expect(handle().classList.contains('visible')).toBe(false);
    // Normal hover works again: hovering b highlights it.
    el('b').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(el('b').classList.contains('redra-hover')).toBe(true);
  });

  it('trash during a session reverts the edit and deletes the block — no editText op', async () => {
    const a = el('a');
    click(a);
    a.innerHTML = 'испорчено'; // an in-progress, uncommitted edit
    (handle().querySelector('.trash') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();

    // The block is gone, and ONLY a deleteBlock op was pushed — the reverted
    // text must never become an editText op.
    expect(document.getElementById('a')).toBeNull();
    const calls = bridge.pushOp.mock.calls as unknown as Array<[{ type: string }]>;
    expect(calls.map((c) => c[0]?.type)).toEqual(['deleteBlock']);
    expect(bridge.pushOp).toHaveBeenCalledWith({ type: 'deleteBlock', id: 'rA' });
  });

  it('duplicate during a session commits the typed text first, then clones', async () => {
    const a = el('a');
    click(a);
    a.innerHTML = 'отредактировано'; // committed text must ride into the clone
    (handle().querySelector('.dup') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();

    // The edit committed as an editText op…
    expect(bridge.pushOp).toHaveBeenCalledWith({
      type: 'editText',
      id: 'rA',
      html: 'отредактировано',
    });
    // …and the clone was requested for the now-committed block.
    expect(bridge.cloneBlock).toHaveBeenCalledTimes(1);
    expect(bridge.cloneBlock).toHaveBeenCalledWith('rA');
    expect(a.hasAttribute('contenteditable')).toBe(false); // session closed
  });

  it('emits availability on session begin (canUndo) and end', () => {
    const emits = (): Array<[{ canUndo: boolean; canRedo: boolean }]> =>
      bridge.emitAvailability.mock.calls as unknown as Array<
        [{ canUndo: boolean; canRedo: boolean }]
      >;

    bridge.emitAvailability.mockClear();
    click(el('a'));
    // The most recent emit after opening a session keeps BOTH live: the native
    // contenteditable stack is independently undoable/redoable via execCommand.
    expect(emits().at(-1)?.[0]).toEqual({ canUndo: true, canRedo: true });

    bridge.emitAvailability.mockClear();
    el('a').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(emits().at(-1)?.[0]).toEqual({ canUndo: false, canRedo: false });
  });
});
