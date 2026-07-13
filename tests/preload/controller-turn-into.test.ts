// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { createEditorController } from '../../src/preload/editor/controller.js';
import type { EditorController } from '../../src/preload/editor/controller.js';
import type { RedraDocBridge } from '../../src/shared/ipc.js';

/**
 * Stage 6: "Turn into …" (Markdown block-type change). The controller swaps the
 * block element live, records an undoable replaceBlock, and pushes the op with
 * the new stamped outerHTML. HTML documents ignore it entirely.
 */

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
const lastOp = (b: ReturnType<typeof makeBridge>) =>
  (b.pushOp.mock.calls as unknown as Array<[{ type: string; id: string; html?: string }]>).at(-1)?.[0];

describe('turnInto (Markdown block-type change)', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let controller: EditorController;
  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
    }
    document.body.innerHTML = '<p data-redra-id="m0" id="a">привет</p><canvas id="bare"></canvas>';
    bridge = makeBridge();
    controller = createEditorController(window, bridge, (r) => normalizeEditedHtml(r, 'md'), 'md');
    controller.setEditing(true);
  });
  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
  });
  const el = (id: string) => document.getElementById(id) as HTMLElement;

  it('paragraph → h1 swaps the element and pushes replaceBlock with the new outerHTML', async () => {
    click(el('a')); // pin/edit the paragraph
    controller.turnInto('h1');
    const h1 = document.querySelector('h1[data-redra-id="m0"]');
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe('привет');
    expect(document.querySelector('p[data-redra-id="m0"]')).toBeNull();
    await flush();
    const op = lastOp(bridge);
    expect(op?.type).toBe('replaceBlock');
    expect(op?.id).toBe('m0');
    expect(op?.html).toContain('<h1 data-redra-id="m0">привет</h1>');
  });

  it('paragraph → bullet list stamps the li for editing', () => {
    click(el('a'));
    controller.turnInto('ul');
    const li = document.querySelector('ul[data-redra-id="m0"] > li[data-redra-id="m0-1"]');
    expect(li).not.toBeNull();
    expect(li!.textContent).toBe('привет');
  });

  it('undo restores the original paragraph', () => {
    click(el('a'));
    controller.turnInto('h2');
    expect(document.querySelector('h2[data-redra-id="m0"]')).not.toBeNull();
    controller.handleUndo();
    expect(document.querySelector('p[data-redra-id="m0"]')).not.toBeNull();
    expect(document.querySelector('h2[data-redra-id="m0"]')).toBeNull();
  });

  it('HTML documents ignore turnInto (no op, no swap)', () => {
    controller.destroy();
    document.body.innerHTML = '<p data-redra-id="r0" id="h">hi</p>';
    const htmlBridge = makeBridge();
    const htmlCtrl = createEditorController(window, htmlBridge, undefined, 'html');
    htmlCtrl.setEditing(true);
    click(document.getElementById('h')!);
    htmlCtrl.turnInto('h1');
    expect(document.querySelector('h1')).toBeNull();
    expect(htmlBridge.pushOp).not.toHaveBeenCalled();
    htmlCtrl.destroy();
  });
});
