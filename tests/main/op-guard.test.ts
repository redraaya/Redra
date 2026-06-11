import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/engine/index.js';
import type { Op } from '../../src/engine/index.js';
import { checkOpAgainstActive, guardDocPush } from '../../src/main/lib/op-guard.js';

// <html>=r0 <head>=r1 <body>=r2 <section>=r3 <p>=r4 <span>=r5 <p>=r6 <div>=r7
const doc = parseDocument(
  '<!doctype html><html><head></head><body>' +
    '<section><p>a<span>s</span></p><p>b</p></section><div>c</div>' +
    '</body></html>',
);

const editText = (id: string, html = 'x'): Op => ({ type: 'editText', id, html });
const deleteBlock = (id: string): Op => ({ type: 'deleteBlock', id });
const moveBlock = (id: string, beforeId: string | null): Op => ({ type: 'moveBlock', id, beforeId });

describe('checkOpAgainstActive (blocked subtrees, mirrors applyOps)', () => {
  it('rejects deleteBlock on a descendant of an edited element', () => {
    const res = checkOpAgainstActive(deleteBlock('r4'), [editText('r3')], doc);
    expect(res).toEqual({ ok: false, error: expect.stringContaining('edited/deleted block') });
  });

  it('rejects editText on a deep descendant of an edited element', () => {
    expect(checkOpAgainstActive(editText('r5'), [editText('r3')], doc).ok).toBe(false);
  });

  it('rejects moveBlock on a descendant of a deleted element', () => {
    expect(checkOpAgainstActive(moveBlock('r4', 'r6'), [deleteBlock('r3')], doc).ok).toBe(false);
  });

  it('rejects any op whose target IS a deleted element (double delete etc.)', () => {
    expect(checkOpAgainstActive(deleteBlock('r3'), [deleteBlock('r3')], doc).ok).toBe(false);
    expect(checkOpAgainstActive(editText('r3'), [deleteBlock('r3')], doc).ok).toBe(false);
    expect(checkOpAgainstActive(moveBlock('r3', null), [deleteBlock('r3')], doc).ok).toBe(false);
  });

  it('rejects moveBlock whose beforeId is deleted or inside an edited subtree', () => {
    expect(checkOpAgainstActive(moveBlock('r6', 'r4'), [deleteBlock('r4')], doc).ok).toBe(false);
    expect(checkOpAgainstActive(moveBlock('r6', 'r4'), [editText('r3')], doc).ok).toBe(false);
  });

  it('allows editText on the SAME element again (replaces the replacement)', () => {
    expect(checkOpAgainstActive(editText('r3'), [editText('r3')], doc)).toEqual({ ok: true });
  });

  it('allows deleteBlock/moveBlock on an edited element itself (children gone, element alive)', () => {
    expect(checkOpAgainstActive(deleteBlock('r3'), [editText('r3')], doc).ok).toBe(true);
    expect(checkOpAgainstActive(moveBlock('r3', null), [editText('r3')], doc).ok).toBe(true);
  });

  it('allows ops on unrelated siblings', () => {
    expect(checkOpAgainstActive(editText('r7'), [deleteBlock('r3')], doc).ok).toBe(true);
    expect(checkOpAgainstActive(deleteBlock('r7'), [editText('r3')], doc).ok).toBe(true);
  });

  it('lifts the block when the blocking op is no longer active (undo)', () => {
    const op = deleteBlock('r4');
    // Journal before undo: editText r3 is active → blocked.
    expect(checkOpAgainstActive(op, [editText('r3')], doc).ok).toBe(false);
    // After journal.undo() the caller passes the shrunken journal.ops → allowed.
    expect(checkOpAgainstActive(op, [], doc).ok).toBe(true);
  });
});

describe('guardDocPush (full ops:push gate)', () => {
  const raw = { type: 'editText', id: 'r4', html: '<b>x</b>' };

  it('rejects a push carrying another document id (stale doc view invoke)', () => {
    const res = guardDocPush('doc-OLD', raw, 'doc-NEW', doc, []);
    expect(res).toEqual({ ok: false, error: expect.stringContaining('doc-OLD') });
    expect(guardDocPush(42, raw, 'doc-NEW', doc, []).ok).toBe(false);
  });

  it('accepts a matching docId with a valid unblocked op (fresh sanitized op)', () => {
    const res = guardDocPush('d1', { ...raw, junk: 1 }, 'd1', doc, []);
    expect(res).toEqual({ ok: true, op: { type: 'editText', id: 'r4', html: '<b>x</b>' } });
  });

  it('still validates shape/ids and the blocked-subtree rule', () => {
    expect(guardDocPush('d1', { type: 'editText', id: 'r999', html: '' }, 'd1', doc, []).ok).toBe(
      false,
    );
    expect(guardDocPush('d1', raw, 'd1', doc, [deleteBlock('r3')]).ok).toBe(false);
  });
});

describe('checkOpAgainstActive: template content (mirrors engine markSubtreeRemoved)', () => {
  // <html>=t0 <head>=t1 <body>=t2 <template>=t3 [content: <tr>=t4 <td>=t5] <p>=t6
  const tdoc = parseDocument(
    '<!doctype html><html><head></head><body>' +
      '<template><tr><td>cell</td></tr></template><p>after</p>' +
      '</body></html>',
  );
  const tpl = 'r3';
  const insideTr = 'r4';
  const insideTd = 'r5';

  it('rejects ops inside template content after editText on the template', () => {
    expect(checkOpAgainstActive(editText(insideTd), [editText(tpl)], tdoc).ok).toBe(false);
    expect(checkOpAgainstActive(deleteBlock(insideTr), [editText(tpl)], tdoc).ok).toBe(false);
  });

  it('rejects ops inside template content after deleteBlock on the template', () => {
    expect(checkOpAgainstActive(editText(insideTd), [deleteBlock(tpl)], tdoc).ok).toBe(false);
    expect(checkOpAgainstActive(moveBlock(insideTr, null), [deleteBlock(tpl)], tdoc).ok).toBe(false);
  });

  it('still allows re-editText on the template itself and ops on siblings', () => {
    expect(checkOpAgainstActive(editText(tpl), [editText(tpl)], tdoc).ok).toBe(true);
    expect(checkOpAgainstActive(editText('r6'), [editText(tpl)], tdoc).ok).toBe(true);
  });
});
