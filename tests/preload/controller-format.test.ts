// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * Format-menu shortcuts (⌘B/⌘I/…): controller.applyFormat routes to the SAME
 * inline-toggle pipeline as a toolbar click. execCommand is a no-op in jsdom,
 * so the wrap toggles (spoiler/code/mark) exercise the Range fallback — enough
 * to prove the menu path reaches and applies the toggle over the selection.
 */

function makeBridge() {
  return {
    pushOp: vi.fn(async () => ({ ok: true as const })),
    cloneBlock: vi.fn(async () => ({ ok: true as const, cloneId: 'c1', html: '<p>x</p>' })),
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

function selectAll(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('controller.applyFormat (Format-menu shortcut)', () => {
  let controller: EditorController;
  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML = '<p data-redra-id="m0" id="a">secret text</p>';
    controller = createEditorController(window, makeBridge(), (r) => normalizeEditedHtml(r, 'md'), 'md');
    controller.setEditing(true);
  });
  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
  });
  const p = () => document.getElementById('a') as HTMLElement;

  it('wraps the selection in <tg-spoiler> for the spoiler command', () => {
    click(p());
    selectAll(p());
    controller.applyFormat('spoiler');
    expect(p().querySelector('tg-spoiler')?.textContent).toBe('secret text');
  });

  it('wraps the selection in <code> for the code command', () => {
    click(p());
    selectAll(p());
    controller.applyFormat('code');
    expect(p().querySelector('code')?.textContent).toBe('secret text');
  });

  it('no-ops without a live session (menu fired at the wrong moment)', () => {
    // No click → no session; a stray shortcut must not throw or mutate.
    expect(() => controller.applyFormat('spoiler')).not.toThrow();
    expect(p().querySelector('tg-spoiler')).toBeNull();
  });
});
