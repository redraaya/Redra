import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../src/engine/index.js';
import { MAX_EDIT_HTML_LENGTH, validateOp } from '../../src/main/lib/validate-op.js';
import { senderMatches } from '../../src/main/lib/sender.js';

// <html>=r0 <head>=r1 <body>=r2 <div>=r3 <p>=r4 <p>=r5 <span>=r6
const doc = parseDocument(
  '<!doctype html><html><head></head><body><div><p>a</p><p>b<span>c</span></p></div></body></html>',
);

describe('validateOp', () => {
  it('accepts a well-formed editText and returns a fresh sanitized op', () => {
    const raw = { type: 'editText', id: 'r4', html: '<b>x</b>', extra: 'junk' };
    const res = validateOp(raw, doc);
    expect(res).toEqual({ ok: true, op: { type: 'editText', id: 'r4', html: '<b>x</b>' } });
    if (res.ok) expect(res.op).not.toBe(raw); // never the wire object
  });

  it('accepts deleteBlock and moveBlock with null beforeId', () => {
    expect(validateOp({ type: 'deleteBlock', id: 'r4' }, doc)).toEqual({
      ok: true,
      op: { type: 'deleteBlock', id: 'r4' },
    });
    expect(validateOp({ type: 'moveBlock', id: 'r4', beforeId: null }, doc)).toEqual({
      ok: true,
      op: { type: 'moveBlock', id: 'r4', beforeId: null },
    });
  });

  it('accepts moveBlock before a real sibling', () => {
    const res = validateOp({ type: 'moveBlock', id: 'r5', beforeId: 'r4' }, doc);
    expect(res.ok).toBe(true);
  });

  it('rejects non-objects and unknown types', () => {
    expect(validateOp(null, doc).ok).toBe(false);
    expect(validateOp('editText', doc).ok).toBe(false);
    expect(validateOp({ type: 'dropTable', id: 'r4' }, doc).ok).toBe(false);
  });

  it('rejects bad or unknown ids', () => {
    expect(validateOp({ type: 'deleteBlock', id: 42 }, doc).ok).toBe(false);
    expect(validateOp({ type: 'deleteBlock', id: '' }, doc).ok).toBe(false);
    expect(validateOp({ type: 'deleteBlock', id: 'r999' }, doc).ok).toBe(false);
  });

  it('rejects editText with non-string or oversized html', () => {
    expect(validateOp({ type: 'editText', id: 'r4', html: 5 }, doc).ok).toBe(false);
    const huge = 'x'.repeat(MAX_EDIT_HTML_LENGTH + 1);
    const res = validateOp({ type: 'editText', id: 'r4', html: huge }, doc);
    expect(res).toEqual({ ok: false, error: expect.stringContaining('exceeds') });
    // exactly at the limit is fine
    expect(validateOp({ type: 'editText', id: 'r4', html: 'x'.repeat(10) }, doc).ok).toBe(true);
  });

  it('rejects moveBlock with bad beforeId: shape, self, unknown, non-sibling', () => {
    expect(validateOp({ type: 'moveBlock', id: 'r4', beforeId: 7 }, doc).ok).toBe(false);
    expect(validateOp({ type: 'moveBlock', id: 'r4' }, doc).ok).toBe(false); // undefined ≠ null
    expect(validateOp({ type: 'moveBlock', id: 'r4', beforeId: 'r4' }, doc).ok).toBe(false);
    expect(validateOp({ type: 'moveBlock', id: 'r4', beforeId: 'r999' }, doc).ok).toBe(false);
    // r6 (span) is a child of r5, not a sibling of r4
    expect(validateOp({ type: 'moveBlock', id: 'r4', beforeId: 'r6' }, doc).ok).toBe(false);
  });
});

describe('senderMatches', () => {
  it('accepts only the exact expected sender', () => {
    const wc = { id: 1 };
    expect(senderMatches({ sender: wc }, wc)).toBe(true);
    expect(senderMatches({ sender: { id: 1 } }, wc)).toBe(false); // identity, not shape
  });

  it('rejects when the expected side does not exist yet', () => {
    expect(senderMatches({ sender: undefined }, undefined)).toBe(false);
    expect(senderMatches({ sender: null }, null)).toBe(false);
  });
});
