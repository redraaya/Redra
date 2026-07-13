// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMdEditorController } from '../../src/preload/editor/md-controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * MD 2.0 editing layer (jsdom slice): whole-document contenteditable, the
 * dirty/commit generation protocol, checkbox toggling, inline wraps via the
 * Range fallback, task-list marking. Native Enter/formatBlock behaviours live
 * in the Chromium probes (scripts/md-editing-probe.cjs), not here.
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
    commitMdBody: vi.fn(async () => ({ ok: true })),
    mdDirty: vi.fn(),
  } satisfies RedraDocBridge;
}

const DOC_ID = 'doc-1';

describe('md-controller: whole-document editing', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;
  let main: HTMLElement;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML =
      '<main><h1 data-redra-id="m0">Заголовок</h1><p data-redra-id="m1" id="p1">secret text</p>' +
      '<ul data-redra-id="m2"><li id="li1">пункт</li></ul></main>';
    main = document.querySelector('main')!;
    bridge = makeBridge();
    controller = createMdEditorController(window, bridge, DOC_ID);
    controller.setEditing(true);
  });
  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
  });

  const selectAll = (el: HTMLElement): void => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };

  it('arms the WHOLE <main> as one contenteditable; disarm removes it', () => {
    expect(main.getAttribute('contenteditable')).toBe('true');
    controller.setEditing(false);
    expect(main.hasAttribute('contenteditable')).toBe(false);
  });

  it('first input announces md:dirty ONCE with a growing generation', () => {
    main.dispatchEvent(new Event('input', { bubbles: true }));
    main.dispatchEvent(new Event('input', { bubbles: true }));
    main.dispatchEvent(new Event('input', { bubbles: true }));
    expect(bridge.mdDirty).toHaveBeenCalledTimes(1);
    expect(bridge.mdDirty).toHaveBeenCalledWith(DOC_ID, 1);
  });

  it('commitActive sends the full body html + the snapshot generation, then re-arms dirty', async () => {
    main.dispatchEvent(new Event('input', { bubbles: true }));
    main.dispatchEvent(new Event('input', { bubbles: true }));
    await controller.commitActive();
    expect(bridge.commitMdBody).toHaveBeenCalledTimes(1);
    const [id, html, gen] = bridge.commitMdBody.mock.calls[0] as unknown as [string, string, number];
    expect(id).toBe(DOC_ID);
    expect(html).toContain('data-redra-id="m1"');
    expect(gen).toBe(2);
    // Re-armed: the next input announces a FRESH dirty generation.
    main.dispatchEvent(new Event('input', { bubbles: true }));
    expect(bridge.mdDirty).toHaveBeenCalledTimes(2);
    expect(bridge.mdDirty).toHaveBeenLastCalledWith(DOC_ID, 3);
  });

  it('applyFormat spoiler/code wraps the selection (Range fallback in jsdom)', () => {
    const p = document.getElementById('p1')!;
    selectAll(p as HTMLElement);
    controller.applyFormat('spoiler');
    expect(p.querySelector('tg-spoiler')?.textContent).toBe('secret text');
  });

  it('checkbox change syncs the checked ATTRIBUTE and the li class, and marks dirty', () => {
    const li = document.getElementById('li1')!;
    li.classList.add('md-task');
    li.insertAdjacentHTML('afterbegin', '<input type="checkbox" contenteditable="false" tabindex="-1"> ');
    const box = li.querySelector('input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(box.hasAttribute('checked')).toBe(true); // attr follows the property
    expect(li.classList.contains('md-task-done')).toBe(true);
    expect(bridge.mdDirty).toHaveBeenCalled();
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(box.hasAttribute('checked')).toBe(false);
    expect(li.classList.contains('md-task-done')).toBe(false);
  });

  it('turnInto("task") marks the selected list item with a real checkbox; again removes it', () => {
    const li = document.getElementById('li1')!;
    selectAll(li as HTMLElement);
    window.getSelection()!.collapseToStart(); // caret inside the li
    controller.turnInto('task');
    expect(li.classList.contains('md-task')).toBe(true);
    expect(li.querySelector('input[type="checkbox"]')).not.toBeNull();
    controller.turnInto('task');
    expect(li.classList.contains('md-task')).toBe(false);
    expect(li.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('never touches per-block chrome: no handles, no pins, no session classes', () => {
    // Clicking a block must not spawn any overlay chrome in the document.
    const p = document.getElementById('p1')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.handle, .indicator, .img-chip')).toBeNull();
  });

  it('checkbox sync survives Preview (lifetime listener): attr/class stay coherent', () => {
    controller.setEditing(false); // Preview — CSS makes boxes inert, but belt stays on
    const li = document.getElementById('li1')!;
    li.classList.add('md-task');
    li.insertAdjacentHTML('afterbegin', '<input type="checkbox" contenteditable="false" tabindex="-1"> ');
    const box = li.querySelector('input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(box.hasAttribute('checked')).toBe(true);
    expect(li.classList.contains('md-task-done')).toBe(true);
  });

  it('⌘Z on a pristine doc does NOT mark it dirty (no-op undo guard)', () => {
    // jsdom has no queryCommandEnabled → the guard reads "nothing to undo".
    controller.handleUndo();
    controller.handleRedo();
    expect(bridge.mdDirty).not.toHaveBeenCalled();
  });

  it('undo/redo are inert in Preview mode', () => {
    controller.setEditing(false);
    controller.handleUndo();
    expect(bridge.mdDirty).not.toHaveBeenCalled();
  });

  it('commitActive resolves FALSE when main rejects the body (over-cap) — the ack must not read as success', async () => {
    bridge.commitMdBody.mockResolvedValueOnce({ ok: false });
    const ok = await controller.commitActive();
    expect(ok).toBe(false);
  });
});
