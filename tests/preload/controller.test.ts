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
    pickImage: vi.fn(async () => ({ ok: true as const, value: 'data:image/png;base64,AA' })),
    replaceImageFromPath: vi.fn(async () => ({
      ok: true as const,
      value: 'data:image/png;base64,BB',
    })),
    pathForFile: vi.fn(() => '/tmp/dropped.png'),
    notifyRejected: vi.fn(),
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

describe('hover survives the trip to the handle pill', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;

  const over = (el: Element, init: MouseEventInit = {}): void => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ...init }));
  };

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML =
      '<p data-redra-id="rA" id="a">первый</p><p data-redra-id="rB" id="b">второй</p>';
    const a = document.getElementById('a')!;
    a.getBoundingClientRect = () =>
      ({ left: 100, right: 300, top: 50, bottom: 80, width: 200, height: 30, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
  });

  it('keeps the hovered block while the pointer crosses the gap to the pill', () => {
    const a = document.getElementById('a')!;
    over(a);
    expect(a.classList.contains('redra-hover')).toBe(true);
    // Pointer leaves the block toward the pill (left of the rect): mouseover
    // fires on the page background where no block resolves — hover must hold.
    over(document.body, { clientX: 70, clientY: 65 });
    expect(a.classList.contains('redra-hover')).toBe(true);
  });

  it('clears the hover when the pointer leaves the reach zone entirely', () => {
    const a = document.getElementById('a')!;
    over(a);
    over(document.body, { clientX: 70, clientY: 300 });
    expect(a.classList.contains('redra-hover')).toBe(false);
  });

  it('switches immediately when another block is hovered', () => {
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    over(a);
    over(b, { clientX: 70, clientY: 65 });
    expect(a.classList.contains('redra-hover')).toBe(false);
    expect(b.classList.contains('redra-hover')).toBe(true);
  });
});

describe('hover for NESTED blocks: parent containers and page wrappers', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;

  const over = (el: Element, init: MouseEventInit = {}): void => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ...init }));
  };

  const rect = (r: Partial<DOMRect>): (() => DOMRect) =>
    () =>
      ({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
        ...r,
      }) as DOMRect;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    // Wrapper fills the viewport (rect stubbed huge); section/p are nested
    // blocks. The section has two children and the wrapper two, so all of
    // them qualify as blocks for resolveBlock.
    document.body.innerHTML =
      '<div data-redra-id="rW" id="w">' +
      '<section data-redra-id="rS" id="s">' +
      '<p data-redra-id="rP" id="p">абзац</p>' +
      '<p data-redra-id="rQ" id="q">второй</p>' +
      '</section>' +
      '<footer data-redra-id="rF" id="f">подвал</footer>' +
      '</div>';
    // The whole document is as tall as the wrapper: a TRUE page wrapper.
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 800,
      configurable: true,
    });
    const wrapper = document.getElementById('w')!;
    wrapper.getBoundingClientRect = rect({
      left: 0,
      right: 1024,
      top: 0,
      bottom: 800,
      width: 1024,
      height: 800, // >= 0.9 * innerHeight (jsdom: 768) AND >= 0.9 * scrollHeight
    });
    document.getElementById('p')!.getBoundingClientRect = rect({
      left: 100,
      right: 300,
      top: 50,
      bottom: 80,
      width: 200,
      height: 30,
    });
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
    delete (document.documentElement as unknown as Record<string, unknown>)['scrollHeight'];
  });

  it('keeps the nested block hovered while the pointer crosses its PARENT toward the pill', () => {
    const p = document.getElementById('p')!;
    over(p);
    expect(p.classList.contains('redra-hover')).toBe(true);
    // En route to the pill the pointer enters the section (an ancestor that
    // resolves as a block) — the hover must not jump to the parent.
    over(document.getElementById('s')!, { clientX: 70, clientY: 65 });
    expect(p.classList.contains('redra-hover')).toBe(true);
    expect(document.getElementById('s')!.classList.contains('redra-hover')).toBe(false);
    // Same when the crossing lands on the page wrapper.
    over(document.getElementById('w')!, { clientX: 60, clientY: 70 });
    expect(p.classList.contains('redra-hover')).toBe(true);
  });

  it('releases the hover when the pointer leaves the reach zone onto an ancestor', () => {
    const p = document.getElementById('p')!;
    const w = document.getElementById('w')!;
    over(p);
    over(w, { clientX: 70, clientY: 300 }); // far below p's reach
    expect(p.classList.contains('redra-hover')).toBe(false);
    // The viewport-filling wrapper itself is suppressed: no hover UI at all.
    expect(w.classList.contains('redra-hover')).toBe(false);
  });

  it('never shows the hover UI for a viewport-filling wrapper, even from cold', () => {
    const w = document.getElementById('w')!;
    over(w, { clientX: 500, clientY: 400 });
    expect(w.classList.contains('redra-hover')).toBe(false);
    expect(document.querySelector('.redra-hover')).toBeNull();
  });

  it('still switches immediately between sibling blocks', () => {
    const p = document.getElementById('p')!;
    const q = document.getElementById('q')!;
    over(p);
    over(q, { clientX: 110, clientY: 60 }); // inside p's reach, but q is no ancestor
    expect(p.classList.contains('redra-hover')).toBe(false);
    expect(q.classList.contains('redra-hover')).toBe(true);
  });
});

describe('tall legit blocks are NOT page wrappers', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;

  const over = (el: Element, init: MouseEventInit = {}): void => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ...init }));
  };

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    // A long table: taller than the viewport (1200 > 0.9*768), but the
    // document is MUCH taller (3000) — the table is content, not a wrapper.
    document.body.innerHTML =
      '<table data-redra-id="rT" id="t"><tbody data-redra-id="rTB">' +
      '<tr data-redra-id="rR1"><td data-redra-id="rD1">a</td></tr>' +
      '<tr data-redra-id="rR2"><td data-redra-id="rD2">b</td></tr>' +
      '</tbody></table>' +
      '<p data-redra-id="rP" id="p">после таблицы</p>';
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 3000,
      configurable: true,
    });
    document.getElementById('t')!.getBoundingClientRect = () =>
      ({
        left: 0,
        right: 1024,
        top: 0,
        bottom: 1200,
        width: 1024,
        height: 1200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
    delete (document.documentElement as unknown as Record<string, unknown>)['scrollHeight'];
  });

  it('a viewport-filling table inside a longer page keeps its hover UI (pill stays usable)', () => {
    const t = document.getElementById('t')!;
    over(t, { clientX: 500, clientY: 400 });
    expect(t.classList.contains('redra-hover')).toBe(true);
  });
});

describe('hover refresh on scroll (large images / scrolled content)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;

  beforeEach(() => {
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)) as unknown as typeof window.requestAnimationFrame;
    document.body.innerHTML =
      '<p data-redra-id="rA" id="a">текст</p><p data-redra-id="rB" id="b">ниже</p>';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, normalizeEditedHtml);
    controller.setEditing(true);
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it('acquires hover for the element scrolled under a stationary pointer', async () => {
    const b = document.getElementById('b')!;
    // The pointer sits still at (50, 60): record it via a mousemove…
    window.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 60 }),
    );
    // …content scrolls underneath; no mouseover boundary is ever crossed,
    // but elementFromPoint now reports <p id=b> under the cursor.
    (document as { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint =
      () => b;
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 0)); // flush the rAF stub
    expect(b.classList.contains('redra-hover')).toBe(true);
  });

  it('drops a stale hover when scrolling moves the block away from the pointer', async () => {
    const a = document.getElementById('a')!;
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(a.classList.contains('redra-hover')).toBe(true);
    window.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 400 }),
    );
    (document as { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint =
      () => document.body;
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 0));
    expect(a.classList.contains('redra-hover')).toBe(false);
  });
});
