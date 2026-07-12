import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { guardMdPush, validateMdOp } from '../../src/md/md-op-guard.js';

const doc = parseMarkdownDoc('# H\n\nАбзац.\n\n- один\n- два\n');
const NONE = new Set<string>();
const DOC_ID = 'doc1';
const push = (raw: unknown, active = [] as Parameters<typeof guardMdPush>[4]) =>
  guardMdPush(DOC_ID, raw, DOC_ID, doc, active, NONE);

describe('md-op-guard: validation', () => {
  it('accepts a well-formed editText on a real block', () => {
    const r = push({ type: 'editText', id: 'm1', html: 'новый' });
    expect(r.ok).toBe(true);
  });

  it('rejects a stale docId', () => {
    const r = guardMdPush('other', { type: 'editText', id: 'm0', html: 'x' }, DOC_ID, doc, [], NONE);
    expect(r).toMatchObject({ ok: false, code: 'stale-doc' });
  });

  it('rejects an unknown id shape', () => {
    expect(validateMdOp({ type: 'editText', id: 'r5', html: 'x' }, doc, NONE)).toMatchObject({ ok: false });
    expect(validateMdOp({ type: 'editText', id: 'm99', html: 'x' }, doc, NONE)).toMatchObject({ ok: false });
  });

  it('rejects setAttr and wire cloneBlock', () => {
    expect(push({ type: 'setAttr', id: 'm0', name: 'src', value: 'x' })).toMatchObject({ ok: false });
    expect(push({ type: 'cloneBlock', id: 'm0', cloneId: 'c1' })).toMatchObject({ ok: false });
  });

  it('rejects an oversize editText payload', () => {
    const big = 'a'.repeat(2 * 1024 * 1024 + 1);
    expect(push({ type: 'editText', id: 'm0', html: big })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('md-op-guard: blocked-subtree (prefix rule)', () => {
  it('after editText m2, a descendant m2-1 is blocked but m2 itself stays legal', () => {
    const active = [{ type: 'editText' as const, id: 'm2', html: '<li>x</li>' }];
    expect(push({ type: 'editText', id: 'm2-1', html: 'y' }, active)).toMatchObject({
      ok: false,
      code: 'blocked-subtree',
    });
    expect(push({ type: 'editText', id: 'm2', html: 'снова' }, active).ok).toBe(true);
  });

  it('after deleteBlock m2, both m2 and m2-1 are blocked', () => {
    const active = [{ type: 'deleteBlock' as const, id: 'm2' }];
    expect(push({ type: 'deleteBlock', id: 'm2' }, active)).toMatchObject({ ok: false, code: 'blocked-subtree' });
    expect(push({ type: 'editText', id: 'm2-1', html: 'y' }, active)).toMatchObject({
      ok: false,
      code: 'blocked-subtree',
    });
  });

  it('an unrelated block is not blocked', () => {
    const active = [{ type: 'editText' as const, id: 'm2', html: 'x' }];
    expect(push({ type: 'editText', id: 'm0', html: 'y' }, active).ok).toBe(true);
  });

  it('a nested editText that cannot resolve is caught by the dry-run', () => {
    // m0 is a heading — it has no child m0-9.
    expect(push({ type: 'editText', id: 'm0-9', html: 'y' })).toMatchObject({ ok: false });
  });
});
