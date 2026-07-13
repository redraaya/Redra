import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderBlockHtml, renderDocumentBody } from '../../src/md/md-render.js';
import { writeBlockHtmlMarkdown } from '../../src/md/md-writer.js';
import { RICH_DEFAULTS, sniffFlavor } from '../../src/md/md-flavor.js';
import type { MdFlavor } from '../../src/md/md-flavor.js';

/**
 * THE writer property (plan risk R1): semantic round-trip. For every
 * supported construct: md → render → write → re-parse → re-render must
 * yield the same DOM (ids stripped — indexes may shift across re-parse).
 * Escaping torture: text with markdown metacharacters must survive as TEXT.
 */

const stripIds = (html: string): string => html.replace(/ data-redra-id="[^"]*"/g, '');

const roundTrip = (md: string, flavor: MdFlavor = RICH_DEFAULTS): { md2: string; same: boolean; a: string; b: string } => {
  const doc = parseMarkdownDoc(md);
  const md2 = doc.blocks
    .map((b) => writeBlockHtmlMarkdown(renderBlockHtml(b), flavor, doc.eol))
    .filter((s) => s !== '')
    .join('\n\n');
  const a = stripIds(renderDocumentBody(parseMarkdownDoc(md).blocks));
  const b = stripIds(renderDocumentBody(parseMarkdownDoc(md2).blocks));
  return { md2, same: a === b, a, b };
};

const CONSTRUCTS: Record<string, string> = {
  'heading levels': '# Раз\n\n#### Четыре\n',
  paragraph: 'Просто абзац из нескольких слов.\n',
  'inline set': '**ж** *к* ~~з~~ ||сп|| ==м== `код` [сс](https://e.com/a) <u>п</u> <sub>н</sub>\n',
  'bold+italic nested': '**жирный с *курсивом* внутри**\n',
  'unordered list': '- раз\n- два\n- три\n',
  'ordered list start': '5. пять\n6. шесть\n',
  'task list': '- [ ] открыто\n- [x] сделано\n',
  'nested list': '- верх\n  - вложенный\n  - ещё\n- низ\n',
  blockquote: '> цитата\n> вторая строка\n',
  'blockquote multi-paragraph': '> первый\n>\n> второй\n',
  'fenced code': '```js\nconst a = 1;\nif (a > 0) { b(); }\n```\n',
  'fence with backticks inside': '````\ncode with ``` inside\n````\n',
  'code no lang': '```\nplain\n```\n',
  table: '| Имя | Число |\n|:---|---:|\n| а | 1 |\n| б | 2 |\n',
  'table with pipes in cell': '| a | b |\n|---|---|\n| п\\|айп | 2 |\n',
  hr: 'до\n\n---\n\nпосле\n',
  image: '![схема](img/a.png)\n',
  'link with parens': '[т](https://e.com/a(b))\n',
  math: '$$\nE = mc^2\n$$\n',
  'inline math': 'До $x^2$ после\n',
  details: '<details><summary>Свернуть</summary><p>внутри</p></details>\n',
  'hard break': 'строка  \nпродолжение\n',
};

describe('md-writer: semantic round-trip per construct', () => {
  for (const [name, md] of Object.entries(CONSTRUCTS)) {
    it(name, () => {
      const r = roundTrip(md);
      expect(r.same, `writer output:\n${r.md2}\n\nA:\n${r.a}\n\nB:\n${r.b}`).toBe(true);
    });
  }
});

describe('md-writer: escaping torture (text stays text)', () => {
  const TORTURE = [
    'звёздочки *не курсив* буквально',      // parses as em — round-trips as em, fine
    'literal asterisk 2 \\* 3 = 6',
    'решётка # не заголовок внутри строки',
    'пайпы a || b || c',
    'равно a == b == c',
    'тильды ~один~ и ~~два~~',
    'скобки [не ссылка] (не адрес)',
    'бэктик ` одинокий',
    'амперсанд &amp; и &nbsp; сущности',
    'html <b>не жирный</b> буквальный? нет — это жирный (наш словарь)',
    'наклонная \\ одна',
  ];
  for (const text of TORTURE) {
    it(JSON.stringify(text.slice(0, 30)), () => {
      const r = roundTrip(text + '\n');
      expect(r.same, `writer output:\n${r.md2}\n\nA:\n${r.a}\n\nB:\n${r.b}`).toBe(true);
    });
  }

  it('paragraph line can never become a block construct', () => {
    // A paragraph whose TEXT begins with markdown block markers.
    for (const nasty of ['\\# not a heading', '\\> not a quote', '\\- not a list', '\\1. not ordered']) {
      const r = roundTrip(nasty + '\n');
      expect(r.same, r.md2).toBe(true);
    }
  });
});

describe('md-writer: flavor adherence', () => {
  it('writes __bold__ when the file already uses __bold__', () => {
    const doc = parseMarkdownDoc('раньше был __жирный__ текст\n\nи *курсив* тоже\n');
    const flavor = sniffFlavor(doc);
    expect(flavor.bold).toBe('__');
    const out = writeBlockHtmlMarkdown('<p data-redra-id="m0"><strong>новый</strong></p>', flavor, '\n');
    expect(out).toBe('__новый__');
  });

  it('bullet marker follows the file (*)', () => {
    const doc = parseMarkdownDoc('* один\n* два\n');
    const flavor = sniffFlavor(doc);
    expect(flavor.bullet).toBe('*');
    const out = writeBlockHtmlMarkdown(
      '<ul data-redra-id="m0"><li data-redra-id="m0-1">новый</li></ul>',
      flavor,
      '\n',
    );
    expect(out).toBe('* новый');
  });

  it('spoiler form follows the file (<tg-spoiler> tag)', () => {
    const doc = parseMarkdownDoc('уже есть <tg-spoiler>старый</tg-spoiler> тут\n');
    const flavor = sniffFlavor(doc);
    expect(flavor.spoiler).toBe('tag');
    const out = writeBlockHtmlMarkdown('<p data-redra-id="m0"><tg-spoiler>с</tg-spoiler></p>', flavor, '\n');
    expect(out).toContain('<tg-spoiler>с</tg-spoiler>');
  });

  it('empty file → Rich defaults', () => {
    const flavor = sniffFlavor(parseMarkdownDoc(''));
    expect(flavor).toEqual(RICH_DEFAULTS);
  });
});

describe('md-writer: the gate (unknown elements contribute text only)', () => {
  it('an element outside the vocabulary cannot smuggle markup', () => {
    const out = writeBlockHtmlMarkdown(
      '<p data-redra-id="m0">до <blink onload="x">текст</blink> после</p>',
      RICH_DEFAULTS,
      '\n',
    );
    expect(out).toBe('до текст после');
  });

  it('island html loses data-redra-* stamps on write', () => {
    const out = writeBlockHtmlMarkdown(
      '<details data-redra-id="m0" data-redra-island="1"><summary>с</summary><p data-redra-id="m0-1">т</p></details>',
      RICH_DEFAULTS,
      '\n',
    );
    expect(out).not.toContain('data-redra');
    expect(out).toContain('<details><summary>с</summary>');
  });
});

const w = (html: string): string => writeBlockHtmlMarkdown(html, RICH_DEFAULTS, '\n');

describe('review round 2: paste/edit artifacts', () => {
  it('a div wrapping BLOCK children writes each child as its own block (VS Code paste)', () => {
    expect(w('<div><div>line1</div><div>line2</div></div>')).toBe('line1\n\nline2');
    expect(w('<div><p>alpha</p><p>beta</p></div>')).toBe('alpha\n\nbeta');
    expect(w('<div><ul><li>a</li><li>b</li></ul></div>')).toBe('- a\n- b');
  });

  it('<br> inside a fence becomes a newline; inside a code span a space', () => {
    expect(w('<pre><code>line1<br>line2</code></pre>')).toBe('```\nline1\nline2\n```');
    expect(w('<p><code>x<br>y</code></p>')).toBe('`x y`');
  });

  it('a garbage <ol start> falls back to 1 (writer is the gate for pasted HTML)', () => {
    expect(w('<ol start="9e99"><li>one</li></ol>')).toBe('1. one');
    expect(w('<ol start="-5"><li>one</li></ol>')).toBe('1. one');
    expect(w('<ol start="7"><li>one</li></ol>')).toBe('7. one');
  });

  it('link and image titles round-trip', () => {
    expect(w('<p><a href="https://e.com" title="The manual">docs</a></p>')).toBe('[docs](https://e.com "The manual")');
    expect(w('<p><img src="pic.png" alt="a" title="cap"></p>')).toBe('![a](pic.png "cap")');
  });
});
