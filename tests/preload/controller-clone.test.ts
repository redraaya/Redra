// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * Block duplication (v0.3.0): the handle pill carries a third button; a
 * click invokes ops:cloneBlock and inserts the STAMPED fragment main
 * returned right after the live block; LocalHistory undo/redo stay in
 * lockstep with the journal (which received the op inside the invoke).
 *
 * The overlay lives in a CLOSED shadow root by design — tests reach its
 * buttons by capturing the root from Element.prototype.attachShadow.
 */

const CLONE_HTML =
  '<p data-redra-id="c1" id="a">привет <b data-redra-id="c1-1">мир</b></p>';

function makeBridge() {
  return {
    pushOp: vi.fn(async () => ({ ok: true as const })),
    cloneBlock: vi.fn(async () => ({ ok: true as const, cloneId: 'c1', html: CLONE_HTML })),
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
    emitAvailability: vi.fn(),
  } satisfies RedraDocBridge;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('block duplication via the handle pill (jsdom)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;
  let shadowRoots: ShadowRoot[];

  const hover = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  };

  /** The handle pill inside the (captured) closed shadow root. */
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
      '<p data-redra-id="rA" id="a">привет <b data-redra-id="rA1">мир</b></p>' +
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

  const blockIds = (): string =>
    Array.from(document.body.children)
      .map((el) => el.getAttribute('data-redra-id'))
      .join(',');

  it('the pill has three buttons: grip, duplicate, trash — in that order', () => {
    hover(document.getElementById('a')!);
    const children = Array.from(handle().children).map((c) => c.className);
    expect(children).toEqual(['grip', 'dup', 'trash']);
  });

  it('clicking duplicate invokes cloneBlock and inserts the stamped fragment after the block', async () => {
    hover(document.getElementById('a')!);
    (handle().querySelector('.dup') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();

    expect(bridge.cloneBlock).toHaveBeenCalledTimes(1);
    expect(bridge.cloneBlock).toHaveBeenCalledWith('rA');
    expect(blockIds()).toBe('rA,c1,rB');
    // the clone carries stamps — the editing layer can target it immediately
    const clone = document.querySelector('[data-redra-id=c1]')!;
    expect(clone.querySelector('[data-redra-id=c1-1]')).not.toBeNull();
    expect(bridge.pushOp).not.toHaveBeenCalled(); // the journal push happened inside the invoke
  });

  it('undo removes the inserted clone and steps the journal; redo re-inserts', async () => {
    hover(document.getElementById('a')!);
    (handle().querySelector('.dup') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();
    expect(blockIds()).toBe('rA,c1,rB');

    controller.handleUndo();
    expect(blockIds()).toBe('rA,rB');
    expect(bridge.undo).toHaveBeenCalledTimes(1);

    controller.handleRedo();
    expect(blockIds()).toBe('rA,c1,rB');
    expect(bridge.redo).toHaveBeenCalledTimes(1);
  });

  it('a rejected cloneBlock inserts nothing, surfaces the notice and leaves no history entry', async () => {
    bridge.cloneBlock.mockResolvedValueOnce({
      ok: false,
      error: 'blocked',
      code: 'blocked-subtree',
      userMessage: 'нельзя',
    } as never);
    hover(document.getElementById('a')!);
    (handle().querySelector('.dup') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();

    expect(blockIds()).toBe('rA,rB');
    expect(bridge.notifyRejected).toHaveBeenCalledWith('нельзя');
    controller.handleUndo(); // nothing local to undo → the journal must not be stepped
    expect(bridge.undo).not.toHaveBeenCalled();
  });

  it('a block leaving the DOM mid-invoke undoes the journaled op (no lockstep skew)', async () => {
    const a = document.getElementById('a')!;
    bridge.cloneBlock.mockImplementationOnce(async () => {
      a.remove(); // page script yanked the block while the invoke was in flight
      return { ok: true as const, cloneId: 'c1', html: CLONE_HTML };
    });
    hover(a);
    const dup = handle().querySelector('.dup') as HTMLElement;
    dup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    // Nothing inserted, and the journal op (already pushed by main inside the
    // invoke) was rolled back — otherwise journal and LocalHistory skew forever.
    expect(document.querySelector('[data-redra-id=c1]')).toBeNull();
    expect(bridge.undo).toHaveBeenCalledTimes(1);

    // No local history entry: a subsequent ⌘Z must not step the journal again.
    controller.handleUndo();
    expect(bridge.undo).toHaveBeenCalledTimes(1);
  });

  it('an insert that does not yield the stamped clone also undoes the journal op', async () => {
    // Defensive path: the returned fragment fails to materialize as the next
    // sibling (e.g. content sanitized away by the DOM). Simulate with html
    // whose root carries the WRONG stamp.
    bridge.cloneBlock.mockResolvedValueOnce({
      ok: true,
      cloneId: 'c9',
      html: '<p data-redra-id="cX">junk</p>',
    } as never);
    hover(document.getElementById('a')!);
    (handle().querySelector('.dup') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();

    expect(bridge.undo).toHaveBeenCalledTimes(1);
    controller.handleUndo();
    expect(bridge.undo).toHaveBeenCalledTimes(1); // no local entry was pushed
  });

  it('duplicating the CLONE works too (it carries stamps like any block)', async () => {
    hover(document.getElementById('a')!);
    (handle().querySelector('.dup') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();

    bridge.cloneBlock.mockResolvedValueOnce({
      ok: true,
      cloneId: 'c2',
      html: '<p data-redra-id="c2">привет</p>',
    } as never);
    hover(document.querySelector('[data-redra-id=c1]')!);
    (handle().querySelector('.dup') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flush();

    expect(bridge.cloneBlock).toHaveBeenLastCalledWith('c1');
    expect(blockIds()).toBe('rA,c1,c2,rB');
  });
});
