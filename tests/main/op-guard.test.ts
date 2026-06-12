import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/engine/index.js';
import type { Op } from '../../src/engine/index.js';
import {
  checkOpAgainstActive,
  guardCloneBlock,
  guardDocPush,
  mintedCloneRoots,
} from '../../src/main/lib/op-guard.js';

// <html>=r0 <head>=r1 <body>=r2 <section>=r3 <p>=r4 <span>=r5 <p>=r6 <div>=r7 <img>=r8
const doc = parseDocument(
  '<!doctype html><html><head></head><body>' +
    '<section><p>a<span>s</span></p><p>b</p></section><div>c</div><img src="x.png">' +
    '</body></html>',
);

const editText = (id: string, html = 'x'): Op => ({ type: 'editText', id, html });
const deleteBlock = (id: string): Op => ({ type: 'deleteBlock', id });
const moveBlock = (id: string, beforeId: string | null): Op => ({ type: 'moveBlock', id, beforeId });
const setAttr = (id: string, value = 'a.png'): Op => ({ type: 'setAttr', id, name: 'src', value });

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

  it('rejects setAttr on a target inside an edited/deleted subtree', () => {
    expect(checkOpAgainstActive(setAttr('r5'), [editText('r3')], doc).ok).toBe(false);
    expect(checkOpAgainstActive(setAttr('r4'), [deleteBlock('r3')], doc).ok).toBe(false);
    expect(checkOpAgainstActive(setAttr('r3'), [deleteBlock('r3')], doc).ok).toBe(false);
  });

  it('allows setAttr on unrelated elements and on an edited element itself', () => {
    expect(checkOpAgainstActive(setAttr('r7'), [editText('r3')], doc).ok).toBe(true);
    // editText replaces CHILDREN; the element itself stays addressable.
    expect(checkOpAgainstActive(setAttr('r3'), [editText('r3')], doc).ok).toBe(true);
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
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining('doc-OLD'),
      code: 'stale-doc',
    });
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

  it('labels every rejection with a code (main picks the user notice by it)', () => {
    expect(guardDocPush('doc-OLD', raw, 'doc-NEW', doc, [])).toMatchObject({
      ok: false,
      code: 'stale-doc',
    });
    expect(guardDocPush('d1', { type: 'editText', id: 'r999', html: '' }, 'd1', doc, [])).toMatchObject(
      { ok: false, code: 'invalid' },
    );
    expect(guardDocPush('d1', raw, 'd1', doc, [deleteBlock('r3')])).toMatchObject({
      ok: false,
      code: 'blocked-subtree',
    });
    expect(
      guardDocPush('d1', { type: 'setAttr', id: 'r8', name: 'src', value: 'a.png' }, 'd1', doc, [
        deleteBlock('r2'),
      ]),
    ).toMatchObject({ ok: false, code: 'blocked-subtree' });
  });

  it('gates setAttr the same way: shape, blocked subtree, docId', () => {
    const rawSet = { type: 'setAttr', id: 'r8', name: 'src', value: 'data:image/png;base64,AA' };
    expect(guardDocPush('d1', rawSet, 'd1', doc, [])).toEqual({
      ok: true,
      op: { type: 'setAttr', id: 'r8', name: 'src', value: 'data:image/png;base64,AA' },
    });
    expect(guardDocPush('stale', rawSet, 'd1', doc, []).ok).toBe(false);
    expect(guardDocPush('d1', { ...rawSet, name: 'onerror' }, 'd1', doc, []).ok).toBe(false);
    // Non-<img> target dies in validateOp before the subtree check.
    expect(guardDocPush('d1', { ...rawSet, id: 'r4' }, 'd1', doc, []).ok).toBe(false);
    // Blocked subtree: the <img> is a body child, so delete the body itself.
    expect(guardDocPush('d1', rawSet, 'd1', doc, [deleteBlock('r2')]).ok).toBe(false);
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

describe('cloneBlock guards (minted ids, prefix rule, channel split)', () => {
  const cloneBlock = (id: string, cloneId: string): Op => ({ type: 'cloneBlock', id, cloneId });

  it('guardDocPush rejects cloneBlock on the ops:push channel (minting is main-only)', () => {
    const res = guardDocPush('d1', { type: 'cloneBlock', id: 'r3', cloneId: 'c1' }, 'd1', doc, []);
    expect(res).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('guardCloneBlock accepts a valid target and returns the sanitized op', () => {
    expect(guardCloneBlock('d1', 'r3', 'c1', 'd1', doc, [])).toEqual({
      ok: true,
      op: { type: 'cloneBlock', id: 'r3', cloneId: 'c1' },
    });
  });

  it('guardCloneBlock rejects stale docId / unknown target / blocked target', () => {
    expect(guardCloneBlock('old', 'r3', 'c1', 'd1', doc, [])).toMatchObject({
      ok: false,
      code: 'stale-doc',
    });
    expect(guardCloneBlock('d1', 'r999', 'c1', 'd1', doc, [])).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(guardCloneBlock('d1', 42, 'c1', 'd1', doc, [])).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    // r4 sits inside deleted r3 → blocked, like any other op.
    expect(guardCloneBlock('d1', 'r4', 'c1', 'd1', doc, [deleteBlock('r3')])).toMatchObject({
      ok: false,
      code: 'blocked-subtree',
    });
  });

  it('guardCloneBlock rejects a cloneId already used by an active cloneBlock', () => {
    expect(
      guardCloneBlock('d1', 'r6', 'c1', 'd1', doc, [cloneBlock('r3', 'c1')]),
    ).toMatchObject({ ok: false, code: 'invalid' });
    // a fresh cloneId is fine, cloning the clone included
    expect(guardCloneBlock('d1', 'c1', 'c2', 'd1', doc, [cloneBlock('r3', 'c1')]).ok).toBe(true);
  });

  it('ops targeting minted ids pass the existence check (root and -n descendants)', () => {
    const active = [cloneBlock('r3', 'c1')];
    expect(guardDocPush('d1', editText('c1'), 'd1', doc, active).ok).toBe(true);
    expect(guardDocPush('d1', editText('c1-2'), 'd1', doc, active).ok).toBe(true);
    expect(guardDocPush('d1', deleteBlock('c1'), 'd1', doc, active).ok).toBe(true);
    // ids of a NEVER-minted root stay unknown
    expect(guardDocPush('d1', editText('c2'), 'd1', doc, active).ok).toBe(false);
    expect(guardDocPush('d1', editText('c2-1'), 'd1', doc, active).ok).toBe(false);
    // without the active cloneBlock nothing is minted
    expect(guardDocPush('d1', editText('c1'), 'd1', doc, []).ok).toBe(false);
  });

  it('deleteBlock on a clone ROOT blocks the root and its whole prefix subtree', () => {
    const active = [cloneBlock('r3', 'c1'), deleteBlock('c1')];
    expect(checkOpAgainstActive(editText('c1'), active, doc).ok).toBe(false);
    expect(checkOpAgainstActive(editText('c1-3'), active, doc).ok).toBe(false);
    expect(checkOpAgainstActive(moveBlock('r6', 'c1'), active, doc).ok).toBe(false);
    // sibling pristine ops stay legal
    expect(checkOpAgainstActive(editText('r7'), active, doc).ok).toBe(true);
  });

  it('editText on a clone ROOT blocks descendants by prefix, the root stays legal', () => {
    const active = [cloneBlock('r3', 'c1'), editText('c1')];
    expect(checkOpAgainstActive(editText('c1-1'), active, doc).ok).toBe(false);
    expect(checkOpAgainstActive(editText('c1'), active, doc).ok).toBe(true);
    expect(checkOpAgainstActive(deleteBlock('c1'), active, doc).ok).toBe(true);
  });

  it('deleteBlock on a clone DESCENDANT blocks the exact id (subtree residue is the engine’s)', () => {
    const active = [cloneBlock('r3', 'c1'), deleteBlock('c1-2')];
    expect(checkOpAgainstActive(editText('c1-2'), active, doc).ok).toBe(false);
    // siblings inside the clone stay legal here — applyOps owns the rest
    expect(checkOpAgainstActive(editText('c1-1'), active, doc).ok).toBe(true);
  });

  it('cloneBlock targets are subject to the blocked-subtree rule via guardCloneBlock', () => {
    const active = [cloneBlock('r3', 'c1'), deleteBlock('c1')];
    expect(guardCloneBlock('d1', 'c1-1', 'c2', 'd1', doc, active)).toMatchObject({
      ok: false,
      code: 'blocked-subtree',
    });
  });

  it('mintedCloneRoots collects exactly the active cloneIds', () => {
    expect(mintedCloneRoots([])).toEqual(new Set());
    expect(mintedCloneRoots([cloneBlock('r3', 'c1'), editText('r4'), cloneBlock('c1', 'c2')])).toEqual(
      new Set(['c1', 'c2']),
    );
  });
});
