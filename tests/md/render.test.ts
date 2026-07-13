import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderBlockHtml, renderDocumentBody } from '../../src/md/md-render.js';

/**
 * Stage-1 renderer contracts:
 *  1) DETERMINISM — same input, same output string, always;
 *  2) THE ID INVARIANT — rendering block i in isolation yields exactly the
 *     ids the full-document render gave it (this is what lets save-time
 *     materialization apply live-DOM ops to a re-rendered block);
 *  3) construct coverage — every supported construct renders to the agreed
 *     vocabulary with stamps in pre-order.
 */

const SAMPLE = `# Заголовок

Абзац с **жирным**, *курсивом*, ~~зачёркнутым~~, ||спойлером||, ==меткой==,
<u>подчёркнутым</u>, $x^2$ и [ссылкой](https://example.com).

- [ ] задача раз
- [x] задача два

> Цитата
> в две строки

\`\`\`js
const x = 1;
\`\`\`

| Колонка | Число |
|---------|------:|
| текст   |    42 |

![схема](img/graph.png)

---

Хвост[^1].

[^1]: сноска.
`;

const idsOf = (html: string): string[] =>
  [...html.matchAll(/data-redra-id="([^"]+)"/g)].map((m) => m[1]!);

describe('md-render: determinism + the id invariant', () => {
  it('render is deterministic (same string twice)', () => {
    const a = renderDocumentBody(parseMarkdownDoc(SAMPLE).blocks);
    const b = renderDocumentBody(parseMarkdownDoc(SAMPLE).blocks);
    expect(a).toBe(b);
  });

  it('ID INVARIANT: isolated block render === same ids as full-document render', () => {
    const doc = parseMarkdownDoc(SAMPLE);
    const full = renderDocumentBody(doc.blocks);
    for (const block of doc.blocks) {
      const isolated = renderBlockHtml(block);
      if (isolated === '') continue;
      const isolatedIds = idsOf(isolated);
      // Every id the isolated render produced must appear in the full render,
      // and the isolated fragment must literally be a slice of it.
      expect(full).toContain(isolated);
      expect(isolatedIds[0]).toBe(block.rootId);
      for (const id of isolatedIds) {
        expect(id === block.rootId || id.startsWith(`${block.rootId}-`)).toBe(true);
      }
    }
  });

  it('ids are unique across the whole document', () => {
    const doc = parseMarkdownDoc(SAMPLE);
    const ids = idsOf(renderDocumentBody(doc.blocks));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('md-render: construct coverage', () => {
  const renderOne = (md: string): string => {
    const doc = parseMarkdownDoc(md);
    expect(doc.blocks.length).toBeGreaterThan(0);
    return renderBlockHtml(doc.blocks[0]!);
  };

  it('heading levels', () => {
    expect(renderOne('# H\n')).toContain('<h1 data-redra-id="m0">H</h1>');
    expect(renderOne('### H3\n')).toContain('<h3');
  });

  it('inline set: strong/em/del/u/spoiler/mark/code/math/link', () => {
    const html = renderOne(
      '**ж** *к* ~~з~~ <u>п</u> ||с|| ==м== `код` $f$ [т](https://e.com)\n',
    );
    expect(html).toContain('<strong>ж</strong>');
    expect(html).toContain('<em>к</em>');
    expect(html).toContain('<s>з</s>');
    expect(html).toContain('<u>п</u>');
    expect(html).toContain('<tg-spoiler>с</tg-spoiler>');
    expect(html).toContain('<mark>м</mark>');
    expect(html).toContain('<code>код</code>');
    expect(html).toContain('md-math');
    expect(html).toContain('href="https://e.com"');
  });

  it('fenced code keeps language as class', () => {
    const html = renderOne('```python\nprint(1)\n```\n');
    expect(html).toContain('class="language-python"');
    expect(html).toContain('print(1)');
  });

  it('code content is escaped, not parsed', () => {
    const html = renderOne('```\n<script>alert(1)</script>\n```\n');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('task list renders md-task classes; tight items carry no phantom <p>', () => {
    const html = renderOne('- [ ] раз\n- [x] два\n');
    expect(html).toContain('md-task');
    expect(html).toContain('md-task-done');
    expect(html).not.toContain('<p');
  });

  it('task items carry a REAL interactive checkbox that survives the sanitizer', () => {
    const html = renderOne('- [ ] раз\n- [x] два\n');
    // Unchecked and checked forms, contenteditable=false (interactive inside
    // the whole-document editable), no other input attrs.
    expect(html).toContain('<input type="checkbox" contenteditable="false" tabindex="-1">');
    expect(html).toContain('checked');
    expect(html).not.toMatch(/<input[^>]* (name|value|on[a-z]+)=/);
  });

  it('table: first row is <th>, alignment classes applied', () => {
    const html = renderOne('| a | b |\n|:-:|--:|\n| 1 | 2 |\n');
    expect(html).toContain('<th class="al-c"');
    expect(html).toContain('<td class="al-r"');
  });

  it('ordered list with start', () => {
    const html = renderOne('5. пять\n6. шесть\n');
    expect(html).toContain('<ol start="5"');
  });

  it('image: stamped, alt kept, relative src kept', () => {
    const html = renderOne('![схема](img/a.png)\n');
    expect(html).toContain('<img data-redra-id="m0-1" src="img/a.png" alt="схема">');
  });

  it('reference-link DEFINITION renders to nothing (bytes stay untouchable)', () => {
    const doc = parseMarkdownDoc('[t][r]\n\n[r]: https://e.com\n');
    const def = doc.blocks.find((b) => b.node.type === 'definition')!;
    expect(renderBlockHtml(def)).toBe('');
  });

  it('unsafe link scheme is neutralized (renderer empties it, sanitizer drops the empty href)', () => {
    // eslint-disable-next-line no-script-url
    const html = renderOne('[x](javascript:alert(1))\n');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a>x</a>'); // link text survives, scheme does not
  });
});
