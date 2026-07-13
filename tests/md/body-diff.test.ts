import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderDocumentBody } from '../../src/md/md-render.js';
import { serializeMdFromBody, roundtripOuter } from '../../src/md/md-body-diff.js';
import { sniffFlavor } from '../../src/md/md-flavor.js';

/**
 * MD 2.0 save core: the live-body block diff. The body the view sends is, for
 * untouched documents, exactly what we served (renderDocumentBody) — so these
 * tests build the body from the render and mutate the HTML string the way the
 * whole-document contenteditable would.
 */

const save = (src: string, mutate: (body: string) => string = (b) => b): string => {
  const doc = parseMarkdownDoc(src);
  return serializeMdFromBody(doc, mutate(renderDocumentBody(doc.blocks)), sniffFlavor(doc));
};

const CORPUS = [
  '# Заголовок\n\nАбзац с **жирным** и [ссылкой](https://e.com).\n',
  'раз\n\nдва\n\nтри\n',
  '# H\npara after single newline\n',
  '- один\n- два\n\n> цитата\n\n```js\nconst x = 1;\n```\n',
  'Text with [ref] link.\n\n[ref]: https://example.com/path\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n',
  'Сноска[^1] тут.\n\n[^1]: пояснение\n',
  '***\n\nпосле линейки\n',
  'CRLF первый.\r\n\r\nCRLF второй.\r\n',
  '\n\n# Файл с ведущими пустыми строками\n\n\nи рваными зазорами\n\n\n',
  '- [ ] задача\n- [x] сделано\n',
  '$$\nx^2\n$$\n',
  '',
];

describe('body-diff: untouched body → byte-identical source', () => {
  for (const [i, src] of CORPUS.entries()) {
    it(`corpus #${i} round-trips byte-for-byte`, () => {
      expect(save(src)).toBe(src);
    });
  }
});

describe('body-diff: single edits stay local', () => {
  it('editing one paragraph rewrites only it; neighbours byte-identical', () => {
    const src = '# Отчёт\n\nПервый абзац.\n\n- пункт один\n- пункт два\n\n> Цитата.\n';
    const out = save(src, (b) => b.replace('Первый абзац.', 'Совсем другой текст.'));
    expect(out).toContain('Совсем другой текст.');
    expect(out).toContain('# Отчёт\n\n');
    expect(out).toContain('- пункт один\n- пункт два');
    expect(out).toContain('> Цитата.\n');
    expect(out).not.toContain('Первый абзац');
  });

  it('appending a new paragraph at the end keeps everything else byte-identical', () => {
    const src = '# H\n\nстарый текст\n';
    const out = save(src, (b) => b + '<p>дописано в конец</p>');
    expect(out).toBe('# H\n\nстарый текст\n\nдописано в конец\n');
  });

  it('a new paragraph inserted between blocks', () => {
    const src = 'раз\n\nдва\n';
    const doc = parseMarkdownDoc(src);
    const body = renderDocumentBody(doc.blocks);
    const [a, b] = body.split('</p>');
    const out = serializeMdFromBody(doc, `${a}</p><p>середина</p>${b}</p>`, sniffFlavor(doc));
    expect(out).toBe('раз\n\nсередина\n\nдва\n');
  });
});

describe('body-diff: deletions and the gap rules (ported from the op-table reviews)', () => {
  it('deleting a heading before a single-newline paragraph does not fuse anything', () => {
    const src = 'para\n# H\nsecond\n';
    const out = save(src, (b) => b.replace(/<h1[^>]*>H<\/h1>/, ''));
    const re = parseMarkdownDoc(out);
    expect(re.blocks.length).toBe(2);
    expect(out).toContain('para');
    expect(out).toContain('second');
  });

  it('deleting a block between a paragraph and a reference definition keeps the definition', () => {
    const src = 'Intro.\n\n# H\n[ref]: https://example.com/a\n';
    const out = save(src, (b) => b.replace(/<h1[^>]*>H<\/h1>/, ''));
    expect(out).toContain('[ref]: https://example.com/a');
  });

  it('deleting everything yields an empty file', () => {
    expect(save('раз\n\nдва\n', () => '')).toBe('');
  });

  it('reordering two pristine blocks synthesizes a valid separator', () => {
    const src = '# H\nпара\n';
    const doc = parseMarkdownDoc(src);
    const body = renderDocumentBody(doc.blocks);
    const h = /<h1[^>]*>H<\/h1>/.exec(body)![0];
    const p = /<p[^>]*>пара<\/p>/.exec(body)![0];
    const out = serializeMdFromBody(doc, p + h, sniffFlavor(doc));
    expect(parseMarkdownDoc(out).blocks.length).toBe(2);
    expect(out.indexOf('пара')).toBeLessThan(out.indexOf('# H'));
  });
});

describe('body-diff: native-editing artifacts', () => {
  it('a split paragraph (Enter) — both halves land, no stale pristine bytes', () => {
    const src = 'первый кусок и второй кусок\n';
    const doc = parseMarkdownDoc(src);
    const out = serializeMdFromBody(
      doc,
      '<p data-redra-id="m0">первый кусок</p><p>и второй кусок</p>',
      sniffFlavor(doc),
    );
    expect(out).toBe('первый кусок\n\nи второй кусок\n');
  });

  it('merged blocks (Backspace joined two paragraphs) — merged content written once', () => {
    const src = 'раз\n\nдва\n';
    const doc = parseMarkdownDoc(src);
    const out = serializeMdFromBody(doc, '<p data-redra-id="m0">раз два</p>', sniffFlavor(doc));
    expect(out).toBe('раз два\n');
  });

  it('a duplicated stamp (block pasted twice) — pristine once, copy written', () => {
    const src = '**жирный** текст\n';
    const doc = parseMarkdownDoc(src);
    const body = renderDocumentBody(doc.blocks);
    const out = serializeMdFromBody(doc, body + body, sniffFlavor(doc));
    expect(out).toBe('**жирный** текст\n\n**жирный** текст\n');
  });

  it('a bare Chromium <div> writes as a paragraph — inline formatting survives, no raw HTML', () => {
    const src = 'x\n';
    const doc = parseMarkdownDoc(src);
    const out = serializeMdFromBody(
      doc,
      '<div>новая строка с <strong>жирным</strong></div>',
      sniffFlavor(doc),
    );
    expect(out).toBe('новая строка с **жирным**\n');
    expect(out).not.toContain('<div');
  });

  it('an empty <p><br></p> spacer adds no content; neighbours stay pristine', () => {
    const src = 'раз\n\nдва\n';
    const doc = parseMarkdownDoc(src);
    const body = renderDocumentBody(doc.blocks);
    const [a, b] = body.split('</p>');
    const out = serializeMdFromBody(doc, `${a}</p><p><br></p>${b}</p>`, sniffFlavor(doc));
    expect(out).toBe('раз\n\nдва\n');
  });

  it('stray top-level text is escaped through the writer, never re-parsed as markup', () => {
    const src = 'x\n';
    const doc = parseMarkdownDoc(src);
    const out = serializeMdFromBody(doc, 'голый текст &lt;script&gt;alert(1)&lt;/script&gt;', sniffFlavor(doc));
    expect(out).toContain('голый текст');
    // The saved text must RE-RENDER as inert text, never as an element.
    const rerendered = renderDocumentBody(parseMarkdownDoc(out).blocks);
    expect(rerendered).not.toContain('<script');
    expect(rerendered).toContain('script'); // the characters survive as text
  });

  it('CRLF source: an edit writes CRLF line endings and preserves CRLF gaps', () => {
    const src = 'первый.\r\n\r\nвторой.\r\n';
    const out = save(src, (b) => b.replace('первый.', 'изменённый.'));
    expect(out).toBe('изменённый.\r\n\r\nвторой.\r\n');
  });
});

describe('body-diff: the writer stays the security gate', () => {
  it('an edited link with an unsafe scheme is blanked', () => {
    const src = 'тут [ссылка](https://ok.com) была\n';
    const out = save(src, (b) => b.replace('https://ok.com', 'javascript:alert(1)'));
    expect(out).not.toContain('javascript:');
  });

  it('a crafted island with a script never reaches the file', () => {
    const src = 'x\n';
    const doc = parseMarkdownDoc(src);
    const out = serializeMdFromBody(
      doc,
      '<details><summary>s</summary><script>alert(1)</script>text</details>',
      sniffFlavor(doc),
    );
    expect(out).not.toContain('<script');
  });

  it('a forged stamp on foreign content is NOT pristine — it goes through the writer', () => {
    const src = 'оригинальный текст\n';
    const doc = parseMarkdownDoc(src);
    const out = serializeMdFromBody(
      doc,
      '<p data-redra-id="m0" onclick="x()">подделка</p>',
      sniffFlavor(doc),
    );
    expect(out).toBe('подделка\n'); // written (attrs differ from pristine), attrs dropped
  });
});

describe('roundtripOuter', () => {
  it('is idempotent (fixpoint)', () => {
    const samples = [
      '<p data-redra-id="m0">а &amp; б &lt;не тег&gt; &nbsp;</p>',
      '<ul data-redra-id="m1"><li>x</li></ul>',
      '<pre data-redra-id="m2"><code class="language-js">const a = 1;</code></pre>',
    ];
    for (const s of samples) {
      const once = roundtripOuter(s);
      expect(roundtripOuter(once)).toBe(once);
    }
  });
});
