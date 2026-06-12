// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * Lockstep tests (I2): the local inverse stack mirrors the main-process
 * journal entry-for-entry. A REJECTED ops:push never reached the journal, so
 * the local entry must be rolled back (DOM reverted) and discarded — Cmd+Z
 * afterwards must not double-revert or call the bridge.
 */

function makeBridge() {
  return {
    pushOp: vi.fn(async () => ({ ok: true as const })),
    cloneBlock: vi.fn(async () => ({ ok: true as const, cloneId: 'c1', html: '<p data-redra-id="c1">x</p>' })),
    undo: vi.fn(async () => ({ ok: true, dirty: false })),
    redo: vi.fn(async () => ({ ok: true, dirty: false })),
    openExternal: vi.fn(),
    pickImage: vi.fn(async () => ({ ok: true as const, value: 'data:image/png;base64,AA' })),
    replaceImageFromPath: vi.fn(async () => ({
      ok: true as const,
      value: 'data:image/png;base64,BB',
    })),
    pathForFile: vi.fn(() => '/tmp/dropped.png'),
    notifyRejected: vi.fn(),
  } satisfies RedraDocBridge;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Commit the active session without opening a new one (blur of the element). */
function blur(el: Element): void {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('controller rollback & lockstep (jsdom)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML =
      '<p data-redra-id="rA" id="a">привет мир</p>' +
      '<h2 data-redra-id="rB" id="b">заголовок</h2>';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
  });

  const el = (id: string) => document.getElementById(id) as HTMLElement;

  it('focusout commits the active session and pushes its op', async () => {
    const a = el('a');
    click(a);
    a.innerHTML = 'после фокуса';
    blur(a);
    await flush();

    expect(a.hasAttribute('contenteditable')).toBe(false);
    expect(bridge.pushOp).toHaveBeenCalledWith({ type: 'editText', id: 'rA', html: 'после фокуса' });
  });

  it('a rejected editText push rolls the DOM back and leaves no undo entry', async () => {
    bridge.pushOp.mockResolvedValueOnce({
      ok: false,
      error: 'inside an edited/deleted block',
    } as never);
    const a = el('a');
    click(a);
    a.innerHTML = 'не пройдёт';
    blur(a);
    await flush();

    // The action visibly bounces back.
    expect(a.innerHTML).toBe('привет мир');

    // Lockstep preserved: nothing local to undo, journal untouched.
    controller.handleUndo();
    await flush();
    expect(bridge.undo).not.toHaveBeenCalled();
    expect(a.innerHTML).toBe('привет мир');
  });

  it('relays main’s localized userMessage via notifyRejected (and only then)', async () => {
    bridge.pushOp.mockResolvedValueOnce({
      ok: false,
      error: '"rA" is inside an edited/deleted block',
      code: 'blocked-subtree',
      userMessage: 'Это действие нельзя применить к уже изменённому блоку',
    } as never);
    const a = el('a');
    click(a);
    a.innerHTML = 'не пройдёт';
    blur(a);
    await flush();

    expect(bridge.notifyRejected).toHaveBeenCalledTimes(1);
    expect(bridge.notifyRejected).toHaveBeenCalledWith(
      'Это действие нельзя применить к уже изменённому блоку',
    );

    // No userMessage (e.g. stale-doc) → rollback stays SILENT.
    bridge.pushOp.mockResolvedValueOnce({ ok: false, error: 'stale', code: 'stale-doc' } as never);
    click(a);
    a.innerHTML = 'тоже не пройдёт';
    blur(a);
    await flush();
    expect(bridge.notifyRejected).toHaveBeenCalledTimes(1);
  });

  it('a rejected push discards ONLY the rejected entry — earlier history survives', async () => {
    const a = el('a');
    click(a);
    a.innerHTML = 'первая правка';
    blur(a);
    await flush();

    bridge.pushOp.mockResolvedValueOnce({ ok: false, error: 'rejected' } as never);
    click(a);
    a.innerHTML = 'вторая правка';
    blur(a);
    await flush();

    expect(a.innerHTML).toBe('первая правка'); // second edit bounced back

    controller.handleUndo(); // undoes the FIRST (accepted) edit
    await flush();
    expect(a.innerHTML).toBe('привет мир');
    expect(bridge.undo).toHaveBeenCalledTimes(1);
  });

  it('handleUndo/handleRedo keep history and journal in lockstep', async () => {
    const a = el('a');
    click(a);
    a.innerHTML = 'правка';
    blur(a);
    await flush();

    controller.handleUndo();
    await flush();
    expect(a.innerHTML).toBe('привет мир');
    expect(bridge.undo).toHaveBeenCalledTimes(1);

    controller.handleRedo();
    await flush();
    expect(a.innerHTML).toBe('правка');
    expect(bridge.redo).toHaveBeenCalledTimes(1);

    // Redo past the end: neither side moves.
    controller.handleRedo();
    await flush();
    expect(bridge.redo).toHaveBeenCalledTimes(1);
  });

  it('handleUndo with empty history never calls the bridge (no journal skew)', () => {
    controller.handleUndo();
    controller.handleRedo();
    expect(bridge.undo).not.toHaveBeenCalled();
    expect(bridge.redo).not.toHaveBeenCalled();
  });
});
