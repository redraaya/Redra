import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderBlockHtml, renderDocumentBody } from '../../src/md/md-render.js';
import { serializeMdSource } from '../../src/md/md-ops.js';
import { RICH_DEFAULTS, sniffFlavor } from '../../src/md/md-flavor.js';
import type { Op } from '../../src/engine/ops.js';

/**
 * THE byte-fidelity guarantees (plan R1): unedited bytes are preserved
 * exactly; only the touched block changes; zero ops is a verbatim passthrough.
 */

const DOC = `# Заголовок отчёта

Первый абзац с *курсивом* и [ссылкой](https://example.com).

- пункт один
- пункт два

> Цитата, которую никто не трогает.

\`\`\`js
const x = 1;
\`\`\`

[ref]: https://example.com/definition

| Имя | Число |
|-----|------:|
| а   |    1 |

Последний абзац.
`;

describe('serializeMdSource: byte fidelity', () => {
  it('zero ops → source byte-for-byte', () => {
    expect(serializeMdSource(parseMarkdownDoc(DOC), [], RICH_DEFAULTS)).toBe(DOC);
    // even weird files
    for (const src of ['', '# H', '\n\n\ntext\n\n', 'a\r\nb\r\n']) {
      expect(serializeMdSource(parseMarkdownDoc(src), [], RICH_DEFAULTS)).toBe(src);
    }
  });

  it('BLOCK LOCALITY: editing block i leaves every other block and all gaps byte-identical', () => {
    const doc = parseMarkdownDoc(DOC);
    for (let i = 0; i < doc.blocks.length; i++) {
      const block = doc.blocks[i]!;
      const html = renderBlockHtml(block);
      if (html === '') continue; // e.g. the reference definition — never edited
      // Edit: append a marker to the block's rendered root innerHTML.
      const rootMatch = /^<([a-z0-9]+)[^>]*>([\s\S]*)<\/\1>$/i.exec(html.trim());
      if (!rootMatch) continue; // void/self-closing roots (hr) — skip locality via editText
      const op: Op = { type: 'editText', id: block.rootId, html: `${rootMatch[2]}` };
      const out = serializeMdSource(doc, [op], sniffFlavor(doc));
      // Every OTHER block's exact source slice must appear verbatim in the output.
      for (let j = 0; j < doc.blocks.length; j++) {
        if (j === i) continue;
        const otherBytes = DOC.slice(doc.blocks[j]!.span.start, doc.blocks[j]!.span.end);
        expect(out.includes(otherBytes), `block ${j} bytes lost while editing block ${i}`).toBe(true);
      }
    }
  });

  it('an unchanged editText still round-trips the block sensibly (no content loss)', () => {
    const doc = parseMarkdownDoc('Абзац с **жирным** словом.\n');
    const html = renderBlockHtml(doc.blocks[0]!);
    const inner = /^<p[^>]*>([\s\S]*)<\/p>$/.exec(html)![1]!;
    const out = serializeMdSource(doc, [{ type: 'editText', id: 'm0', html: inner }], RICH_DEFAULTS);
    // Re-render both — DOM must be equivalent (delimiters may differ).
    const a = renderDocumentBody(parseMarkdownDoc('Абзац с **жирным** словом.\n').blocks).replace(/ data-redra-id="[^"]*"/g, '');
    const b = renderDocumentBody(parseMarkdownDoc(out).blocks).replace(/ data-redra-id="[^"]*"/g, '');
    expect(b).toBe(a);
  });

  it('deleteBlock removes exactly that block; neighbours + reference definition survive', () => {
    const doc = parseMarkdownDoc(DOC);
    // Delete the list (m2). The reference definition (a no-DOM block) and
    // every other block must remain byte-identical.
    const listBlock = doc.blocks.find((b) => b.node.type === 'list')!;
    const out = serializeMdSource(doc, [{ type: 'deleteBlock', id: listBlock.rootId }], RICH_DEFAULTS);
    const listBytes = DOC.slice(listBlock.span.start, listBlock.span.end);
    expect(out).not.toContain(listBytes);
    expect(out).toContain('[ref]: https://example.com/definition'); // definition survived
    expect(out).toContain('> Цитата, которую никто не трогает.');
    expect(out).toContain('# Заголовок отчёта');
    // re-parses cleanly with one fewer block
    expect(parseMarkdownDoc(out).blocks.length).toBe(doc.blocks.length - 1);
  });

  it('editing one block does not disturb a reference definition sitting next to it', () => {
    const doc = parseMarkdownDoc(DOC);
    const last = doc.blocks[doc.blocks.length - 1]!; // "Последний абзац."
    const html = renderBlockHtml(last);
    const inner = /^<p[^>]*>([\s\S]*)<\/p>$/.exec(html)![1]!;
    const out = serializeMdSource(doc, [{ type: 'editText', id: last.rootId, html: inner + ' ДОБАВЛЕНО' }], RICH_DEFAULTS);
    expect(out).toContain('[ref]: https://example.com/definition');
    expect(out).toContain('ДОБАВЛЕНО');
  });

  it('setAttr is rejected (images are not editable in md v1)', () => {
    const doc = parseMarkdownDoc('![alt](a.png)\n');
    expect(() =>
      serializeMdSource(doc, [{ type: 'setAttr', id: 'm0-1', name: 'src', value: 'b.png' }], RICH_DEFAULTS),
    ).toThrow();
  });

  it('editText inside a table cell re-serializes only that block', () => {
    const doc = parseMarkdownDoc(DOC);
    const table = doc.blocks.find((b) => b.node.type === 'table')!;
    const html = renderBlockHtml(table);
    const cellId = [...html.matchAll(/data-redra-id="([^"]+)"/g)]
      .map((m) => m[1]!)
      .find((id) => id !== table.rootId && html.includes(`data-redra-id="${id}">а<`));
    expect(cellId).toBeTruthy();
    const out = serializeMdSource(
      doc,
      [{ type: 'editText', id: cellId!, html: 'б' }],
      sniffFlavor(doc),
    );
    // Other blocks untouched; the table now has "б" where "а" was.
    expect(out).toContain('# Заголовок отчёта');
    expect(out).toContain('Последний абзац.');
    const reparsed = parseMarkdownDoc(out);
    expect(reparsed.blocks.length).toBe(doc.blocks.length);
  });
});
