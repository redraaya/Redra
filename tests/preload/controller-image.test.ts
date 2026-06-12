// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * Image replacement (v0.2.0): click on an original <img> opens the picker,
 * a drop of an OS file lands in replaceImageFromPath, the live src is set
 * and a setAttr op is pushed; a rejected push rolls the live DOM back.
 */

const PICKED = 'data:image/png;base64,AA';
const DROPPED = 'data:image/png;base64,BB';

function makeBridge() {
  return {
    pushOp: vi.fn(async () => ({ ok: true as const })),
    undo: vi.fn(async () => ({ ok: true, dirty: false })),
    redo: vi.fn(async () => ({ ok: true, dirty: false })),
    openExternal: vi.fn(),
    pickImage: vi.fn(async () => ({ ok: true as const, value: PICKED })),
    replaceImageFromPath: vi.fn(async () => ({ ok: true as const, value: DROPPED })),
    pathForFile: vi.fn(() => '/tmp/dropped.png'),
    notifyRejected: vi.fn(),
  } satisfies RedraDocBridge;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function click(el: Element): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/** jsdom has no DragEvent/DataTransfer ctors — fake the fields it reads. */
function drop(el: Element, files: unknown[]): Event {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', {
    value: { files, types: ['Files'] },
  });
  el.dispatchEvent(e);
  return e;
}

describe('image replacement (jsdom)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;
  let pageClicks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML =
      '<p data-redra-id="rA" id="a">текст</p>' +
      '<img data-redra-id="rI" id="img" src="old.png" alt="x">' +
      '<img id="scripted" src="dyn.png">';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
    pageClicks = vi.fn();
    document.addEventListener('click', pageClicks);
  });

  afterEach(() => {
    document.removeEventListener('click', pageClicks);
    controller.destroy();
    document.body.innerHTML = '';
  });

  const img = () => document.getElementById('img') as HTMLImageElement;

  it('click on a stamped <img> → pickImage → live src set → setAttr pushed', async () => {
    const e = click(img());
    await flush();

    expect(e.defaultPrevented).toBe(true);
    expect(pageClicks).not.toHaveBeenCalled(); // page handlers stay suppressed
    expect(bridge.pickImage).toHaveBeenCalledWith('rI');
    expect(img().getAttribute('src')).toBe(PICKED);
    expect(bridge.pushOp).toHaveBeenCalledWith({
      type: 'setAttr',
      id: 'rI',
      name: 'src',
      value: PICKED,
    });
    expect(document.querySelector('[contenteditable]')).toBeNull(); // no text session
  });

  it('a scripted (unstamped) <img> never triggers the picker', async () => {
    click(document.getElementById('scripted')!);
    await flush();
    expect(bridge.pickImage).not.toHaveBeenCalled();
    expect(bridge.pushOp).not.toHaveBeenCalled();
  });

  it('canceled picker leaves the DOM and the journal untouched', async () => {
    bridge.pickImage.mockResolvedValueOnce({ ok: false, canceled: true } as never);
    click(img());
    await flush();
    expect(img().getAttribute('src')).toBe('old.png');
    expect(bridge.pushOp).not.toHaveBeenCalled();
  });

  it('click on an img first commits the active text session', async () => {
    const a = document.getElementById('a') as HTMLElement;
    click(a);
    a.innerHTML = 'правка';
    click(img());
    await flush();

    expect(a.hasAttribute('contenteditable')).toBe(false);
    expect(bridge.pushOp).toHaveBeenCalledWith({ type: 'editText', id: 'rA', html: 'правка' });
    expect(bridge.pushOp).toHaveBeenCalledWith({
      type: 'setAttr',
      id: 'rI',
      name: 'src',
      value: PICKED,
    });
  });

  it('undo/redo round-trips the live src through the local history', async () => {
    click(img());
    await flush();
    expect(img().getAttribute('src')).toBe(PICKED);

    controller.handleUndo();
    await flush();
    expect(img().getAttribute('src')).toBe('old.png');
    expect(bridge.undo).toHaveBeenCalledTimes(1);

    controller.handleRedo();
    await flush();
    expect(img().getAttribute('src')).toBe(PICKED);
  });

  it('a rejected setAttr push rolls the live src back and leaves no undo entry', async () => {
    bridge.pushOp.mockResolvedValueOnce({ ok: false, error: 'rejected' } as never);
    click(img());
    await flush();

    expect(img().getAttribute('src')).toBe('old.png');
    controller.handleUndo();
    expect(bridge.undo).not.toHaveBeenCalled();
  });

  it('drop of an OS file on a stamped img → replaceImageFromPath with the resolved path', async () => {
    const file = { name: 'dropped.png' };
    const e = drop(img(), [file]);
    await flush();

    expect(e.defaultPrevented).toBe(true); // never navigate the doc view
    expect(bridge.pathForFile).toHaveBeenCalledWith(file);
    expect(bridge.replaceImageFromPath).toHaveBeenCalledWith('rI', '/tmp/dropped.png');
    expect(img().getAttribute('src')).toBe(DROPPED);
    expect(bridge.pushOp).toHaveBeenCalledWith({
      type: 'setAttr',
      id: 'rI',
      name: 'src',
      value: DROPPED,
    });
  });

  it('drop with no files / on a non-img does nothing', async () => {
    drop(img(), []);
    drop(document.getElementById('a')!, [{ name: 'x.png' }]);
    await flush();
    expect(bridge.replaceImageFromPath).not.toHaveBeenCalled();
  });

  it('main rejecting the dropped file (bad type/size) leaves the DOM untouched', async () => {
    bridge.replaceImageFromPath.mockResolvedValueOnce({ ok: false, error: 'too big' } as never);
    drop(img(), [{ name: 'huge.png' }]);
    await flush();
    expect(img().getAttribute('src')).toBe('old.png');
    expect(bridge.pushOp).not.toHaveBeenCalled();
  });

  it('«Просмотр» (setEditing(false)) hands img clicks back to the page', async () => {
    controller.setEditing(false);
    click(img());
    await flush();
    expect(bridge.pickImage).not.toHaveBeenCalled();
    expect(pageClicks).toHaveBeenCalledTimes(1);
  });
});
