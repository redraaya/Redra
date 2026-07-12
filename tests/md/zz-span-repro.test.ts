import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderBlockHtml, renderDocumentBody } from '../../src/md/md-render.js';
import { writeBlockHtmlMarkdown } from '../../src/md/md-writer.js';
import { serializeMdSource } from '../../src/md/md-ops.js';
import { RICH_DEFAULTS } from '../../src/md/md-flavor.js';

const stripIds = (html: string): string => html.replace(/ data-redra-id="[^"]*"/g, '');

describe('span repro', () => {
  it('shows rendered/sanitized HTML for a plain span', () => {
    const doc = parseMarkdownDoc('x <span>y</span> z\n');
    const rendered = doc.blocks.map((b) => renderBlockHtml(b)).join('\n');
    console.log('RENDERED:', JSON.stringify(rendered));
  });

  it('round-trips a plain inline span', () => {
    const md = 'x <span>y</span> z\n';
    const doc = parseMarkdownDoc(md);
    const written = doc.blocks
      .map((b) => writeBlockHtmlMarkdown(renderBlockHtml(b), RICH_DEFAULTS, doc.eol))
      .filter((s) => s !== '')
      .join('\n\n');
    console.log('WRITER OUTPUT:', JSON.stringify(written));
    const a = stripIds(renderDocumentBody(parseMarkdownDoc(md).blocks));
    const b = stripIds(renderDocumentBody(parseMarkdownDoc(written).blocks));
    console.log('A:', a);
    console.log('B:', b);
    console.log('SAME:', a === b);
  });

  it('real save path: editText that keeps the span in op.html', () => {
    const md = 'x <span>y</span> z\n';
    const doc = parseMarkdownDoc(md);
    console.log('SOURCE BEFORE:', JSON.stringify(doc.source));
    // Simulate the editor sending back the block innerHTML unchanged (user
    // clicked in the paragraph, typed nothing meaningful, span still present).
    const rendered = renderBlockHtml(doc.blocks[0]!);
    console.log('BLOCK RENDERED:', JSON.stringify(rendered));
    // Extract inner of the <p> as the editor would (rough): everything the
    // block innerHTML holds. We use the rendered <p>...</p> inner.
    const inner = rendered.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '');
    const op = { type: 'editText' as const, id: 'm0', html: inner };
    const out = serializeMdSource(doc, [op], RICH_DEFAULTS);
    console.log('SAVED AFTER EDIT:', JSON.stringify(out));
  });
});
