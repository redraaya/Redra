import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderDocumentBody } from '../../src/md/md-render.js';
import { toClipboardHtml } from '../../src/md/telegram/to-clipboard-html.js';

/**
 * "Copy for Telegram" — the 2026 composer contract:
 *   text  = the clean GFM source itself (asserted at the md-doc level: it IS
 *           serializeMdLive's output, no escaping dialects);
 *   html  = STANDARD document HTML — our own render scrubbed of every
 *           internal artefact, exactly what a browser-style rich paste needs.
 */

const html = (src: string): string =>
  toClipboardHtml(renderDocumentBody(parseMarkdownDoc(src).blocks));

describe('clipboard HTML: standard document markup', () => {
  it('keeps real headings, lists, quotes, code and tables', () => {
    const out = html(
      '# Заголовок\n\nАбзац с **жирным** и [ссылкой](https://e.com).\n\n- пункт\n\n> цитата\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    );
    expect(out).toContain('<h1>Заголовок</h1>');
    expect(out).toContain('<b>жирным</b>'); // naive-parser-friendly pair
    expect(out).toContain('<a href="https://e.com">ссылкой</a>');
    expect(out).toContain('<ul><li>пункт</li></ul>');
    expect(out).toContain('<blockquote>');
    expect(out).toContain('<pre><code>const x = 1;</code></pre>');
    expect(out).toContain('<table>');
  });

  it('carries NO internal artefacts: stamps, classes, inputs, contenteditable', () => {
    const out = html('- [x] сделано\n- [ ] нет\n\n||секрет|| и ==маркер==\n');
    expect(out).not.toContain('data-redra');
    expect(out).not.toContain('class=');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('contenteditable');
    expect(out).not.toContain('tg-spoiler');
  });

  it('task checkboxes become text glyphs; spoilers unwrap to their text', () => {
    const out = html('- [x] сделано\n- [ ] нет\n\n||секрет||\n');
    expect(out).toContain('☑ сделано');
    expect(out).toContain('☐ нет');
    expect(out).toContain('секрет');
  });

  it('highlight stays a standard <mark>', () => {
    expect(html('==важное==\n')).toContain('<mark>важное</mark>');
  });

  it('an unsafe link scheme never reaches the clipboard (render already blanks it)', () => {
    const out = html('[x](javascript:alert(1))\n');
    expect(out).not.toContain('javascript:');
  });
});
