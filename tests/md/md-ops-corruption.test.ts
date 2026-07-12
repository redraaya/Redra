import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderBlockHtml, renderDocumentBody } from '../../src/md/md-render.js';
import { serializeMdSource } from '../../src/md/md-ops.js';
import { guardMdPush } from '../../src/md/md-op-guard.js';
import { RICH_DEFAULTS } from '../../src/md/md-flavor.js';
import type { Op } from '../../src/engine/ops.js';

/**
 * Regression suite for the Stage-2 adversarial-review findings — every one of
 * these was a confirmed SILENT .md corruption or writer-gate bypass in the
 * save path. They must never come back.
 */

const save = (src: string, ops: Op[]): string =>
  serializeMdSource(parseMarkdownDoc(src), ops, RICH_DEFAULTS);
const blocksOf = (src: string): number => parseMarkdownDoc(src).blocks.length;
const NONE = new Set<string>();

describe('review: id stability across a splicing op (clone/move) — later ops hit the right block', () => {
  it('clone m0, then edit m2 → the ORIGINAL third block is edited, nothing lost', () => {
    // Was: cloneBlock shifts table indices, so editText m2 hit the wrong entry.
    const out = save('AAA\n\nBBB\n\nCCC\n', [
      { type: 'cloneBlock', id: 'm0', cloneId: 'c1' },
      { type: 'editText', id: 'm2', html: 'ZZZ' },
    ]);
    expect(out).toBe('AAA\n\nAAA\n\nBBB\n\nZZZ\n');
  });

  it('delete m0, then edit m2 → edits the surviving CCC, keeps BBB', () => {
    const out = save('AAA\n\nBBB\n\nCCC\n', [
      { type: 'deleteBlock', id: 'm0' },
      { type: 'editText', id: 'm2', html: 'ZZZ' },
    ]);
    expect(out).toBe('BBB\n\nZZZ\n');
  });
});

describe('review: moveBlock gap accounting — no glued blocks, no leaked leading gap', () => {
  it('move the FIRST block to the end: blocks preserved, correctly separated', () => {
    const out = save('# A\n\n# B\n\n# C\n', [{ type: 'moveBlock', id: 'm0', beforeId: null }]);
    expect(out).toBe('# B\n\n# C\n\n# A\n');
    expect(blocksOf(out)).toBe(3);
  });

  it('move a block TO the head: no leading blank line, no glue', () => {
    const out = save('# A\n\n# B\n\n# C\n', [{ type: 'moveBlock', id: 'm2', beforeId: 'm0' }]);
    expect(out).toBe('# C\n\n# A\n\n# B\n');
    expect(blocksOf(out)).toBe(3);
  });

  it('paragraphs never fuse across a move', () => {
    const out = save('AAA\n\nBBB\n\nCCC\n', [{ type: 'moveBlock', id: 'm1', beforeId: 'm0' }]);
    expect(out).toBe('BBB\n\nAAA\n\nCCC\n');
    expect(blocksOf(out)).toBe(3);
  });
});

describe('review: deleteBlock of the first block does not leak the inter-block gap', () => {
  it('delete m0 → the file head is clean, no leading blank lines', () => {
    expect(save('First.\n\nSecond.\n', [{ type: 'deleteBlock', id: 'm0' }])).toBe('Second.\n');
  });
  it('authored leading blanks are preserved when the head block survives', () => {
    expect(save('\n\n\nAlpha\n\nBeta\n', [{ type: 'deleteBlock', id: 'm1' }])).toBe('\n\n\nAlpha\n');
  });
});

describe('review: loose (multi-paragraph) list items do not glue their paragraphs', () => {
  it('editing item 3 re-serializes item 1 without fusing "para" + "second"', () => {
    const src = '- first para\n\n  second para\n- third\n';
    const doc = parseMarkdownDoc(src);
    // find the third item's id
    const listHtml = renderBlockHtml(doc.blocks[0]!);
    const thirdId = [...listHtml.matchAll(/data-redra-id="([^"]+)"/g)]
      .map((m) => m[1]!)
      .find((id) => listHtml.includes(`data-redra-id="${id}">third<`) || listHtml.includes(`data-redra-id="${id}"`) && listHtml.split(`data-redra-id="${id}"`)[1]!.startsWith('>third'));
    const out = serializeMdSource(doc, [{ type: 'editText', id: thirdId ?? 'm0-4', html: 'third EDITED' }], RICH_DEFAULTS);
    expect(out).not.toContain('parasecond');
    // both paragraphs of item 1 survive as distinct words
    expect(out).toContain('first para');
    expect(out).toContain('second para');
    // and re-parses to a list with the same item count
    expect(renderDocumentBody(parseMarkdownDoc(out).blocks)).toContain('third EDITED');
  });
});

describe('review: heading with a trailing # is not truncated on re-parse', () => {
  it('"Title #" round-trips (not read as an ATX close)', () => {
    const src = '# Title \\#\n';
    const doc = parseMarkdownDoc(src);
    const inner = /^<h1[^>]*>([\s\S]*)<\/h1>$/.exec(renderBlockHtml(doc.blocks[0]!))![1]!;
    const out = serializeMdSource(doc, [{ type: 'editText', id: 'm0', html: inner }], RICH_DEFAULTS);
    const reHtml = renderDocumentBody(parseMarkdownDoc(out).blocks);
    expect(reHtml).toContain('Title #');
  });
});

describe('review: footnote reference round-trips as [^label], not literal <sup>', () => {
  it('editing a paragraph with a footnote keeps the [^1] marker', () => {
    const src = 'Текст[^1] со сноской.\n\n[^1]: определение\n';
    const doc = parseMarkdownDoc(src);
    const inner = /^<p[^>]*>([\s\S]*)<\/p>$/.exec(renderBlockHtml(doc.blocks[0]!))![1]!;
    const out = serializeMdSource(doc, [{ type: 'editText', id: 'm0', html: inner }], RICH_DEFAULTS);
    expect(out).toContain('[^1]');
    expect(out).not.toContain('<sup');
  });
});

describe('review: writer-gate — editText on a raw-HTML island cannot write active content', () => {
  it('script / handlers / javascript: urls are stripped on save', () => {
    const src = '<details><summary>s</summary>ok</details>\n';
    const doc = parseMarkdownDoc(src);
    // Forge a malicious editText payload on the island root (as a compromised
    // page script could): the writer is the last gate and must sanitize.
    const evil =
      '<summary>s</summary><script>alert(1)</script><a href="javascript:alert(2)" onclick="x()">t</a><img src="x" onerror="y()">';
    const out = serializeMdSource(doc, [{ type: 'editText', id: 'm0', html: evil }], RICH_DEFAULTS);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });
});

describe('review: guard rejects an editText on a no-DOM (empty-render) block', () => {
  it('a reference-definition block is rejected at push, not thrown at save', () => {
    const doc = parseMarkdownDoc('para one\n\n[ref]: https://example.com/x\n\npara two\n');
    // m1 is the definition (renders to '').
    const res = guardMdPush('d', { type: 'editText', id: 'm1', html: 'x' }, 'd', doc, [], NONE);
    expect(res.ok).toBe(false);
    // And a save with that op would not silently corrupt (it never reaches disk
    // because the guard rejected it) — but even if forced, it throws, not writes.
    expect(() => serializeMdSource(doc, [{ type: 'editText', id: 'm1', html: 'x' }], RICH_DEFAULTS)).toThrow();
  });
});
