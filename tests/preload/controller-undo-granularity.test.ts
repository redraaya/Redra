// @vitest-environment jsdom
//
// v0.4 single-timeline undo: a block edit no longer collapses into one undo
// step. The user's exact repro (edit three spots in block A, one in block B,
// then press Undo) must peel B, then A's three edits one at a time. Also guards
// the redo-button fix, Escape-rolls-back-all-N, and the cross-block guard.
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
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const opTypes = (b: ReturnType<typeof makeBridge>) =>
  (b.pushOp.mock.calls as unknown as Array<[{ type: string; id: string; html?: string }]>).map((c) => c[0]);

describe('undo granularity (single timeline)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML =
      '<p data-redra-id="rA" id="a">A0</p><h2 data-redra-id="rB" id="b">B0</h2><canvas id="bare"></canvas>';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });
  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
  });
  const el = (id: string) => document.getElementById(id) as HTMLElement;

  it("THE REPRO: three edits in block A are three undo steps; block B is one", async () => {
    const a = el('a');
    const b = el('b');
    // Edit three spots in A; a click to a new spot inside the same block seals
    // the previous edit as its own checkpoint (no typed space needed).
    click(a); // open session on A
    a.innerHTML = 'A1';
    click(a); // reposition → seal edit 1
    a.innerHTML = 'A1A2';
    click(a); // reposition → seal edit 2
    a.innerHTML = 'A1A2A3';
    click(b); // commit A (final flush → edit 3) and open B
    b.innerHTML = 'B1';
    click(el('bare')); // commit B (non-editable target → no new session)
    await flush();

    // Four editText ops: three on rA (one per edit), one on rB.
    expect(opTypes(bridge)).toEqual([
      { type: 'editText', id: 'rA', html: 'A1' },
      { type: 'editText', id: 'rA', html: 'A1A2' },
      { type: 'editText', id: 'rA', html: 'A1A2A3' },
      { type: 'editText', id: 'rB', html: 'B1' },
    ]);

    // Press Undo four times: B reverts, then A's three edits one at a time.
    controller.handleUndo();
    expect(el('b').innerHTML).toBe('B0'); // B reverted; A still edited
    expect(el('a').innerHTML).toBe('A1A2A3');
    controller.handleUndo();
    expect(el('a').innerHTML).toBe('A1A2');
    controller.handleUndo();
    expect(el('a').innerHTML).toBe('A1');
    controller.handleUndo();
    expect(el('a').innerHTML).toBe('A0'); // back to pristine, four distinct steps
    await flush();
    expect(bridge.undo).toHaveBeenCalledTimes(4);
  });

  it('Escape rolls back EVERY checkpoint pushed this session', async () => {
    const a = el('a');
    click(a);
    a.innerHTML = 'A1';
    click(a); // seal edit 1 (checkpoint)
    a.innerHTML = 'A1A2';
    click(a); // seal edit 2 (checkpoint)
    a.innerHTML = 'A1A2-tail';
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();

    expect(a.innerHTML).toBe('A0'); // pristine restored, tail included
    expect(a.hasAttribute('contenteditable')).toBe(false);
    // Two checkpoints pushed, then two journal undos rolled them back — net zero.
    expect(bridge.pushOp).toHaveBeenCalledTimes(2);
    expect(bridge.undo).toHaveBeenCalledTimes(2);
    // Nothing left to undo (no orphan history): a journal undo would no-op.
    bridge.undo.mockClear();
    controller.handleUndo();
    await flush();
    expect(bridge.undo).not.toHaveBeenCalled();
  });

  it('cross-block guard: mid-session Undo never reverts a prior block under the caret', async () => {
    // Commit block A (one checkpoint), then open and edit block B.
    click(el('a'));
    el('a').innerHTML = 'A1';
    click(el('b')); // commit A, open B
    el('b').innerHTML = 'B1';
    click(el('b')); // seal B's edit as a checkpoint (still in B's session)
    await flush();

    // Press 1: reverts B's own checkpoint (A must stay edited).
    controller.handleUndo();
    expect(el('b').innerHTML).toBe('B0');
    expect(el('a').innerHTML).toBe('A1'); // prior block untouched
    // Press 2: B has nothing left → commit B, do NOT revert A yet.
    controller.handleUndo();
    expect(el('a').innerHTML).toBe('A1');
    expect(el('b').hasAttribute('contenteditable')).toBe(false); // B committed
    // Press 3: now post-commit — reverts A.
    controller.handleUndo();
    expect(el('a').innerHTML).toBe('A0');
  });

  it('redo button: canRedo stays false until an undo, then true, then false at the tip', async () => {
    const av = bridge.emitAvailability.mock.calls as unknown as Array<[{ canUndo: boolean; canRedo: boolean }]>;
    const last = () => av.at(-1)?.[0];
    click(el('a'));
    el('a').innerHTML = 'A1';
    click(el('bare')); // commit → one checkpoint
    await flush();
    expect(last()).toEqual({ canUndo: true, canRedo: false }); // Undo only

    controller.handleUndo();
    await flush();
    expect(last()).toEqual({ canUndo: false, canRedo: true }); // Redo appears

    controller.handleRedo();
    await flush();
    expect(last()).toEqual({ canUndo: true, canRedo: false }); // back at the tip → Redo hidden
  });

  it('cross-block redo cannot resurrect a prior block or lose data', async () => {
    click(el('a'));
    el('a').innerHTML = 'A1';
    click(el('bare')); // commit A → one checkpoint
    await flush();
    controller.handleUndo(); // undo A's edit
    await flush();
    expect(el('a').innerHTML).toBe('A0');

    // Open a session on a DIFFERENT block; A's redo tail survives.
    click(el('b'));
    bridge.undo.mockClear();
    controller.handleRedo(); // must be suppressed (cross-block)
    expect(el('a').innerHTML).toBe('A0'); // A NOT resurrected under B's caret

    el('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    expect(el('a').innerHTML).toBe('A0'); // A's undone state preserved — no data loss
    expect(bridge.undo).not.toHaveBeenCalled(); // B had no checkpoints → zero journal undos
  });

  it('a rejected in-session checkpoint bounces back and does NOT over-undo on Escape', async () => {
    bridge.pushOp.mockResolvedValueOnce({ ok: false, error: 'stale-doc' } as never);
    click(el('a'));
    el('a').innerHTML = 'A1';
    click(el('a')); // reposition → flushCheckpoint pushes (rejected async)
    await flush();
    expect(el('a').innerHTML).toBe('A0'); // the rejected checkpoint bounced back

    // pushedThisSession was restored to 0 on reject, so Escape sends no spurious
    // bridge.undo against a journal that recorded nothing.
    bridge.undo.mockClear();
    el('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    expect(bridge.undo).not.toHaveBeenCalled();
  });
});
