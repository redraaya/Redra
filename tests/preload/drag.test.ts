// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDrag } from '../../src/preload/editor/drag.js';
import type { DragDeps, DropInfo } from '../../src/preload/editor/drag.js';
import type { Overlay } from '../../src/preload/editor/overlay.js';

/**
 * Drag-reorder tests (A2). jsdom 29 ships a real PointerEvent constructor,
 * so pointerdown/move/up/cancel go through the same dispatch path as in
 * Chromium. Geometry is the one thing jsdom cannot do — every block's
 * getBoundingClientRect is stubbed to a fixed vertical layout.
 */

interface Rect {
  top: number;
  bottom: number;
  left?: number;
  width?: number;
}

function stubRect(el: Element, r: Rect): void {
  el.getBoundingClientRect = () =>
    ({
      top: r.top,
      bottom: r.bottom,
      left: r.left ?? 0,
      right: (r.left ?? 0) + (r.width ?? 600),
      width: r.width ?? 600,
      height: r.bottom - r.top,
      x: r.left ?? 0,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
}

function makeOverlay() {
  return {
    hideHandle: vi.fn(),
    showGhost: vi.fn(),
    moveGhost: vi.fn(),
    hideGhost: vi.fn(),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
  } as unknown as Overlay;
}

describe('drag-reorder (jsdom + PointerEvent)', () => {
  let blockA: HTMLElement;
  let onDrop: ReturnType<typeof vi.fn<(info: DropInfo) => void>>;
  let onEnd: ReturnType<typeof vi.fn>;
  let deps: DragDeps;

  beforeEach(() => {
    document.body.innerHTML =
      '<main id="parent">' +
      '<section data-redra-id="rA" id="A">A</section>' +
      '<section data-redra-id="rB" id="B">B</section>' +
      '<section data-redra-id="rC" id="C">C</section>' +
      '</main>';
    const parent = document.getElementById('parent')!;
    blockA = document.getElementById('A')!;
    stubRect(parent, { top: 0, bottom: 300 });
    stubRect(blockA, { top: 0, bottom: 90 });
    stubRect(document.getElementById('B')!, { top: 100, bottom: 140 });
    stubRect(document.getElementById('C')!, { top: 150, bottom: 190 });
    onDrop = vi.fn();
    onEnd = vi.fn();
    deps = { win: window, overlay: makeOverlay(), onDrop, onEnd };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('pointerdown→move→up reports the nearest gap with the stamped beforeId', () => {
    startDrag(blockA, pointer('pointerdown', 0, 10), deps);
    window.dispatchEvent(pointer('pointermove', 5, 148)); // nearest gap: before C (y=150)
    window.dispatchEvent(pointer('pointerup', 5, 148));

    expect(onDrop).toHaveBeenCalledTimes(1);
    const info = onDrop.mock.calls[0]![0];
    expect(info.block).toBe(blockA);
    expect(info.beforeEl).toBe(document.getElementById('C'));
    expect(info.beforeId).toBe('rC');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('redra-dragging')).toBe(false);
  });

  it('dropping into the end gap reports beforeEl/beforeId = null', () => {
    startDrag(blockA, pointer('pointerdown', 0, 10), deps);
    window.dispatchEvent(pointer('pointermove', 5, 189)); // end gap: y=190
    window.dispatchEvent(pointer('pointerup', 5, 189));

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![0]).toMatchObject({ beforeEl: null, beforeId: null });
  });

  it('dropping back before our own next sibling is NOT a move — no op', () => {
    startDrag(blockA, pointer('pointerdown', 0, 10), deps);
    window.dispatchEvent(pointer('pointermove', 5, 99)); // nearest gap: before B (= A.nextElementSibling)
    window.dispatchEvent(pointer('pointerup', 5, 99));

    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('movement under the threshold never starts a drag', () => {
    startDrag(blockA, pointer('pointerdown', 0, 10), deps);
    window.dispatchEvent(pointer('pointermove', 1, 11)); // < DRAG_THRESHOLD
    window.dispatchEvent(pointer('pointerup', 1, 11));

    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels the drag: no drop, listeners removed', () => {
    startDrag(blockA, pointer('pointerdown', 0, 10), deps);
    window.dispatchEvent(pointer('pointermove', 5, 148));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);

    expect(esc.defaultPrevented).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('redra-dragging')).toBe(false);

    // Listeners are gone: a late pointerup must not re-finish.
    window.dispatchEvent(pointer('pointerup', 5, 148));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('pointercancel aborts exactly like Escape', () => {
    startDrag(blockA, pointer('pointerdown', 0, 10), deps);
    window.dispatchEvent(pointer('pointermove', 5, 148));
    window.dispatchEvent(pointer('pointercancel', 5, 148));

    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('redra-dragging')).toBe(false);

    window.dispatchEvent(pointer('pointerup', 5, 148));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('unstamped elements at the drop point are skipped forward for beforeId', () => {
    // Insert a script-created (unstamped) element between B and C.
    const ghost = document.createElement('aside');
    ghost.id = 'X';
    document.getElementById('parent')!.insertBefore(ghost, document.getElementById('C'));
    stubRect(ghost, { top: 142, bottom: 148 });

    startDrag(blockA, pointer('pointerdown', 0, 10), deps);
    window.dispatchEvent(pointer('pointermove', 5, 143)); // nearest gap: before X (y=142)
    window.dispatchEvent(pointer('pointerup', 5, 143));

    expect(onDrop).toHaveBeenCalledTimes(1);
    const info = onDrop.mock.calls[0]![0];
    expect(info.beforeEl).toBe(ghost); // live-DOM insertion point stays exact
    expect(info.beforeId).toBe('rC'); // op references the next STAMPED sibling
  });
});
