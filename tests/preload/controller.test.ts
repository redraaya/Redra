// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * Controller-level tests (A1/A4): the capture-phase listeners on `window`
 * must suppress page handlers while editing is armed, hand the page back in
 * «Просмотр», and route clicks/keys into sessions and bridge calls.
 */

function makeBridge() {
  return {
    pushOp: vi.fn(async () => ({ ok: true as const })),
    undo: vi.fn(async () => ({ ok: true, dirty: false })),
    redo: vi.fn(async () => ({ ok: true, dirty: false })),
    openExternal: vi.fn(),
  } satisfies RedraDocBridge;
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

/** Flush the microtasks of `void endSession(true)` → await pushOp. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('editor controller (jsdom)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;
  let pageClicks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML =
      '<p data-redra-id="rA" id="a">привет мир</p>' +
      '<h2 data-redra-id="rB" id="b">заголовок</h2>' +
      '<p data-redra-id="rL"><a data-redra-id="rL1" href="https://example.com/doc">ссылка</a></p>' +
      '<canvas id="bare"></canvas>';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
    // A "page script" handler: bubble phase on document, like real pages do.
    pageClicks = vi.fn();
    document.addEventListener('click', pageClicks);
  });

  afterEach(() => {
    document.removeEventListener('click', pageClicks);
    controller.destroy();
    document.body.innerHTML = '';
  });

  const el = (id: string) => document.getElementById(id) as HTMLElement;

  it('suppresses page click handlers on an editable target while armed', () => {
    const e = click(el('a'));
    expect(pageClicks).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(el('a').getAttribute('contenteditable')).toBe('true'); // session opened
  });

  it('suppresses page click handlers even on a non-editable target', () => {
    const e = click(el('bare')); // no data-redra-id → never editable
    expect(pageClicks).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector('[contenteditable]')).toBeNull(); // and no session
  });

  it('hands clicks back to the page in «Просмотр» (setEditing(false))', () => {
    controller.setEditing(false);
    const e = click(el('a'));
    expect(pageClicks).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    expect(el('a').hasAttribute('contenteditable')).toBe(false);
  });

  it('clicking another element commits the active session before opening a new one', async () => {
    const a = el('a');
    const b = el('b');
    click(a);
    expect(a.getAttribute('contenteditable')).toBe('true');
    a.innerHTML = 'отредактировано';

    // Capture B's state at the exact moment the op is pushed: the commit
    // must land BEFORE a session opens on B.
    let bEditableAtPush: boolean | null = null;
    bridge.pushOp.mockImplementationOnce(async () => {
      bEditableAtPush = b.hasAttribute('contenteditable');
      return { ok: true as const };
    });

    click(b);
    await flush();

    expect(bridge.pushOp).toHaveBeenCalledTimes(1);
    expect(bridge.pushOp).toHaveBeenCalledWith({
      type: 'editText',
      id: 'rA',
      html: 'отредактировано',
    });
    expect(bEditableAtPush).toBe(false);
    expect(a.hasAttribute('contenteditable')).toBe(false);
    expect(b.getAttribute('contenteditable')).toBe('true');
  });

  it('Cmd/Ctrl+click on a link opens it externally and starts no session', () => {
    const anchor = document.querySelector('a')!;
    const e = click(anchor, { metaKey: true });
    expect(bridge.openExternal).toHaveBeenCalledTimes(1);
    expect(bridge.openExternal).toHaveBeenCalledWith('https://example.com/doc');
    expect(e.defaultPrevented).toBe(true);
    expect(pageClicks).not.toHaveBeenCalled();
    expect(document.querySelector('[contenteditable]')).toBeNull();
    expect(bridge.pushOp).not.toHaveBeenCalled();
  });

  it('Escape reverts the session and pushes no op', async () => {
    const a = el('a');
    click(a);
    a.innerHTML = 'испорчено';
    const esc = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    a.dispatchEvent(esc);
    await flush();

    expect(esc.defaultPrevented).toBe(true);
    expect(a.innerHTML).toBe('привет мир'); // exact pre-session markup restored
    expect(a.hasAttribute('contenteditable')).toBe(false);
    expect(bridge.pushOp).not.toHaveBeenCalled();
  });

  it('destroy() removes the capture listeners — clicks reach the page again', () => {
    controller.destroy();
    const e = click(el('a'));
    expect(pageClicks).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    expect(el('a').hasAttribute('contenteditable')).toBe(false);
  });
});
