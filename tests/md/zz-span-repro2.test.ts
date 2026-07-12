import { describe, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderBlockHtml } from '../../src/md/md-render.js';
import { writeBlockHtmlMarkdown } from '../../src/md/md-writer.js';
import { RICH_DEFAULTS } from '../../src/md/md-flavor.js';

const show = (md: string) => {
  const doc = parseMarkdownDoc(md);
  const rendered = doc.blocks.map((b) => renderBlockHtml(b)).join('\n');
  const written = doc.blocks
    .map((b) => writeBlockHtmlMarkdown(renderBlockHtml(b), RICH_DEFAULTS, doc.eol))
    .filter((s) => s !== '')
    .join('\n\n');
  console.log('IN :', JSON.stringify(md));
  console.log('REN:', JSON.stringify(rendered));
  console.log('OUT:', JSON.stringify(written));
  console.log('---');
};

describe('span content preservation', () => {
  it('probes span variants', () => {
    show('x <span>**y**</span> z\n');            // inline formatting inside span
    show('x <span class="foo">y</span> z\n');    // arbitrary class
    show('x <span style="color:red">y</span> z\n'); // style attribute
    show('x <span id="anchor">y</span> z\n');    // id attribute
    show('x <span class="md-math">y</span> z\n'); // known class (math branch)
    show('a<span></span>b\n');                    // empty span as separator
  });
});
