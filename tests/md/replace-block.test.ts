import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { serializeMdSource } from '../../src/md/md-ops.js';
import { guardMdPush } from '../../src/md/md-op-guard.js';
import { RICH_DEFAULTS } from '../../src/md/md-flavor.js';
import { parseDocument, serializeSource } from '../../src/engine/index.js';
import { validateOp } from '../../src/main/lib/validate-op.js';
import type { Op } from '../../src/engine/ops.js';

const NONE = new Set<string>();
const save = (src: string, ops: Op[]): string => serializeMdSource(parseMarkdownDoc(src), ops, RICH_DEFAULTS);

describe('replaceBlock: Markdown block-type change', () => {
  it('turn a paragraph into a heading', () => {
    const out = save('обычный текст\n', [
      { type: 'replaceBlock', id: 'm0', html: '<h1 data-redra-id="m0">обычный текст</h1>' },
    ]);
    expect(out).toBe('# обычный текст\n');
  });
  it('turn a paragraph into a bullet list', () => {
    const out = save('пункт\n', [
      { type: 'replaceBlock', id: 'm0', html: '<ul data-redra-id="m0"><li data-redra-id="m0-1">пункт</li></ul>' },
    ]);
    expect(out).toBe('- пункт\n');
  });
  it('turn a paragraph into a quote, untouched blocks preserved', () => {
    const out = save('первый\n\nвторой\n', [
      { type: 'replaceBlock', id: 'm0', html: '<blockquote data-redra-id="m0"><p>первый</p></blockquote>' },
    ]);
    expect(out).toBe('> первый\n\nвторой\n');
  });
  it('a replaceBlock cannot smuggle active content (writer gate)', () => {
    const out = save('x\n', [
      { type: 'replaceBlock', id: 'm0', html: '<p data-redra-id="m0"><script>alert(1)</script>hi</p>' },
    ]);
    expect(out).not.toContain('<script');
    expect(out).toContain('hi');
  });
});

describe('replaceBlock: guard', () => {
  const doc = parseMarkdownDoc('a\n\nb\n');
  it('accepts a top-level block id', () => {
    const res = guardMdPush('d', { type: 'replaceBlock', id: 'm0', html: '<h1 data-redra-id="m0">a</h1>' }, 'd', doc, [], NONE);
    expect(res.ok).toBe(true);
  });
  it('rejects a nested id', () => {
    const res = guardMdPush('d', { type: 'replaceBlock', id: 'm0-1', html: '<p>x</p>' }, 'd', doc, [], NONE);
    expect(res.ok).toBe(false);
  });
  it('rejects an unknown block', () => {
    const res = guardMdPush('d', { type: 'replaceBlock', id: 'm9', html: '<p>x</p>' }, 'd', doc, [], NONE);
    expect(res.ok).toBe(false);
  });
});

describe('replaceBlock: the HTML engine rejects it entirely', () => {
  it('validateOp (HTML) rejects the op type', () => {
    const doc = parseDocument('<!doctype html><body><p data-redra-id="r0">x</p></body>');
    const res = validateOp({ type: 'replaceBlock', id: 'r0', html: '<h1>x</h1>' }, doc);
    expect(res.ok).toBe(false);
  });
  it('applyOps (HTML) throws if one ever reaches it (via serializeSource)', () => {
    const doc = parseDocument('<!doctype html><body><p data-redra-id="r0">x</p></body>');
    expect(() => serializeSource(doc, [{ type: 'replaceBlock', id: 'r0', html: '<h1>x</h1>' } as Op])).toThrow();
  });
});
