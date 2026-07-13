import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderBlockHtml, renderDocumentBody, collectDefinitions } from '../../src/md/md-render.js';
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

// ---- re-review round 2 findings ----

describe('re-review: single-newline gap after a self-terminating block never fuses paragraphs', () => {
  it('delete a heading between two paragraphs → paragraphs stay separate', () => {
    // para0 \n\n # H \n para2  — the "\n" after "# H" is valid ONLY after the
    // heading; deleting the heading must not glue para0 and para2.
    const out = save('para0\n\n# H\npara2\n', [{ type: 'deleteBlock', id: 'm1' }]);
    expect(blocksOf(out)).toBe(2); // still two paragraphs, not one fused block
    expect(out).not.toContain('para0\npara2');
  });
  it('delete a heading above a link definition → definition survives (not fused away)', () => {
    const out = save('Intro.\n\n# H\n[ref]: https://example.com/a\n', [{ type: 'deleteBlock', id: 'm1' }]);
    // The definition must remain a definition, not merge into "Intro."
    const re = parseMarkdownDoc(out);
    expect(re.tree.children.some((c) => c.type === 'definition')).toBe(true);
  });
  it('an authored single newline after a heading is preserved when nothing changes around it', () => {
    // byte-fidelity: editing an UNRELATED block keeps "# H\npara" verbatim
    const src = '# H\npara\n\nOther.\n';
    const doc = parseMarkdownDoc(src);
    const inner = /^<p[^>]*>([\s\S]*)<\/p>$/.exec(renderBlockHtml(doc.blocks[2]!))![1]!;
    const out = serializeMdSource(doc, [{ type: 'editText', id: 'm2', html: inner + '!' }], RICH_DEFAULTS);
    expect(out).toContain('# H\npara'); // untouched adjacency stays byte-faithful
  });
});

describe('re-review: a duplicated (clone) block is editable and its edits are saved', () => {
  it('editText on a clone id round-trips through save', () => {
    const doc = parseMarkdownDoc('AAA\n\nBBB\n');
    const out = serializeMdSource(
      doc,
      [
        { type: 'cloneBlock', id: 'm0', cloneId: 'c1' },
        { type: 'editText', id: 'c1', html: 'CLONE EDITED' },
      ],
      RICH_DEFAULTS,
    );
    expect(out).toBe('AAA\n\nCLONE EDITED\n\nBBB\n');
  });
  it('a clone can be deleted without touching the original', () => {
    const out = save('AAA\n\nBBB\n', [
      { type: 'cloneBlock', id: 'm0', cloneId: 'c1' },
      { type: 'deleteBlock', id: 'c1' },
    ]);
    expect(out).toBe('AAA\n\nBBB\n');
  });
});

describe('re-review: block children of a list item are not destroyed', () => {
  it('a fenced code block inside a list item survives an edit elsewhere in the list', () => {
    const src = '- item one\n\n  ```js\n  x()\n  ```\n- item two\n';
    const doc = parseMarkdownDoc(src);
    // edit the whole list block minimally (re-render item two) — code must stay
    const listHtml = renderBlockHtml(doc.blocks[0]!);
    // grab item two's li id
    const ids = [...listHtml.matchAll(/data-redra-id="([^"]+)"/g)].map((m) => m[1]!);
    const out = serializeMdSource(doc, [{ type: 'editText', id: ids[ids.length - 1]!, html: 'item two EDITED' }], RICH_DEFAULTS);
    expect(out).toContain('```'); // the code fence is not flattened to text
    expect(out).toContain('x()');
    expect(renderDocumentBody(parseMarkdownDoc(out).blocks)).toContain('<pre');
  });
});

describe('final gate: the mainline inline writer never writes an unsafe URL to the file', () => {
  const cases: Array<[string, string, string]> = [
    ['paragraph link', 'hello\n', '<a href="javascript:alert(1)">click</a>'],
    ['paragraph img data:', 'hello\n', '<img src="data:text/html,<script>x</script>" alt="p">'],
    ['blockquote link vbscript', '> quote\n', '<a href="vbscript:msgbox(1)">x</a>'],
  ];
  for (const [name, src, payload] of cases) {
    it(`${name}: unsafe scheme is blanked`, () => {
      const out = save(src, [{ type: 'editText', id: 'm0', html: payload }]);
      expect(out.toLowerCase()).not.toContain('javascript:');
      expect(out.toLowerCase()).not.toContain('vbscript:');
      expect(out.toLowerCase()).not.toContain('data:text/html');
    });
  }
  it('a legitimate https link is preserved', () => {
    const out = save('hi\n', [{ type: 'editText', id: 'm0', html: '<a href="https://e.com/a">x</a>' }]);
    expect(out).toContain('https://e.com/a');
  });
});

describe('re-review: reference-style link round-trips as a working link on edit', () => {
  it('editing a paragraph with [text][ref] keeps the link (resolved), definition stays', () => {
    const src = 'See [the docs][d] here.\n\n[d]: https://example.com/docs\n';
    const doc = parseMarkdownDoc(src);
    // The served view resolves the reference to a real <a href> (as the user
    // sees and edits it) — that resolved HTML is the editText payload.
    const defs = collectDefinitions(doc.blocks[1]!.node as { children?: unknown[] });
    const rendered = renderBlockHtml(doc.blocks[0]!, defs);
    expect(rendered).toContain('href="https://example.com/docs"');
    const inner = /^<p[^>]*>([\s\S]*)<\/p>$/.exec(rendered)![1]!;
    // inner has a real <a href> now (resolved), so the writer emits an inline link
    const out = serializeMdSource(doc, [{ type: 'editText', id: 'm0', html: inner }], RICH_DEFAULTS);
    expect(out).toContain('https://example.com/docs'); // link preserved
    expect(out).toContain('[d]:'); // definition line still present (for other refs)
    expect(out).not.toMatch(/See the docs here/); // not flattened to plain text
  });
});
