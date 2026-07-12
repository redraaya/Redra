import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc, decompositionIsExact, detectEol } from '../../src/md/md-parse.js';

/**
 * Stage-1 foundation: the gap/block decomposition identity is THE invariant
 * the whole byte-faithful save strategy rests on. It must hold for anything
 * a user can open, including files that are barely markdown at all.
 */

const CASES: Record<string, string> = {
  simple: '# Заголовок\n\nАбзац текста.\n',
  'no trailing newline': '# H\n\nтекст',
  'leading blank lines': '\n\n\n# H\n',
  'CRLF file': '# H\r\n\r\nАбзац.\r\n\r\n- один\r\n- два\r\n',
  'setext heading': 'Заголовок\n=========\n\nтекст\n',
  'indented code': 'абзац\n\n    старый стиль кода\n    вторая строка\n\nконец\n',
  'fenced code with lang': '```js\nconst x = 1;\n```\n',
  'tilde fence': '~~~python\nprint(1)\n~~~\n',
  'reference links': '[текст][ref]\n\n[ref]: https://example.com\n',
  'gfm table': '| a | b |\n|---|---:|\n| 1 | 2 |\n',
  'task list': '- [ ] раз\n- [x] два\n',
  'footnotes (gfm)': 'текст[^1]\n\n[^1]: сноска\n',
  'math dollars': 'Инлайн $x^2$ и блок:\n\n$$\nE=mc^2\n$$\n',
  'spoilers and marks': 'Тут ||секрет|| и ==жёлтое== место.\n',
  'escaped spoiler': 'Тут \\|\\|не спойлер\\|\\| остаётся.\n',
  'html block island': '<div class="widget">\n<b>х</b>\n</div>\n\nабзац\n',
  'inline html': 'Слово <u>подчёркнутое</u> тут.\n',
  'details block': '<details><summary>Свернуть</summary>\n\nвнутри\n\n</details>\n',
  'blockquote + expandable': '> цитата\n> вторая строка\n\n<details><summary>Ещё</summary>текст</details>\n',
  'weird gaps': '# H\n\n\n\n\nтекст после многих пустых\n\n\n',
  'only whitespace': '   \n\n  \n',
  empty: '',
  'lists nested': '- уровень 1\n  - уровень 2\n    1. нумерованный\n- обратно\n',
  'thematic breaks': 'до\n\n---\n\n***\n\n___\n\nпосле\n',
  'bom-free umlauts and emoji': 'Ünïcode 🎯 текст\n\nвторой 🚀\n',
  'windows mixed eol': 'строка\r\nвторая\nтретья\r\n',
  'trailing spaces hard break': 'строка  \nпродолжение\n',
  'literal pipes in text': 'a || b || c || d\n',
  'crlf in fenced code': '```\r\nline\r\n```\r\n',
};

describe('md-parse: gap/block decomposition', () => {
  for (const [name, source] of Object.entries(CASES)) {
    it(`identity holds: ${name}`, () => {
      const doc = parseMarkdownDoc(source);
      expect(decompositionIsExact(doc)).toBe(true);
      expect(doc.gaps.length).toBe(doc.blocks.length + 1);
    });
  }

  it('random corpus: identity holds for seeded pseudo-markdown', () => {
    // Tiny deterministic generator — no dependency, reproducible failures.
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const atoms = [
      '# H1\n', '## H2\n', 'абзац с **жирным** и *курсивом*\n', '\n', '\n\n',
      '- пункт\n', '1. пункт\n', '> цитата\n', '```\nкод\n```\n', '---\n',
      '| a | b |\n|---|---|\n| 1 | 2 |\n', 'текст с ||спойлером||\n',
      '<u>u</u> инлайн\n', '    отступ-код\n', '[a][r]\n', '[r]: http://x\n',
      'хвост без перевода строки', '\r\n', 'CRLF строка\r\n', '==метка== текст\n',
    ];
    for (let n = 0; n < 200; n++) {
      let src = '';
      const parts = 1 + Math.floor(rnd() * 12);
      for (let p = 0; p < parts; p++) src += atoms[Math.floor(rnd() * atoms.length)]!;
      const doc = parseMarkdownDoc(src);
      expect(decompositionIsExact(doc), `corpus #${n}:\n${JSON.stringify(src)}`).toBe(true);
    }
  });

  it('block ids are m0..mN in document order', () => {
    const doc = parseMarkdownDoc('# a\n\nб\n\n- в\n');
    expect(doc.blocks.map((b) => b.rootId)).toEqual(['m0', 'm1', 'm2']);
  });

  it('empty file: zero blocks, one gap equal to the source', () => {
    const doc = parseMarkdownDoc('');
    expect(doc.blocks).toHaveLength(0);
    expect(doc.gaps).toEqual(['']);
  });
});

describe('md-parse: eol detection', () => {
  it('detects LF, CRLF and defaults to LF on ties', () => {
    expect(detectEol('a\nb\n')).toBe('\n');
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(detectEol('a\r\nb\n')).toBe('\n'); // tie → LF
    expect(detectEol('без переводов')).toBe('\n');
  });
});

describe('md-inline: spoiler and mark passes', () => {
  const findTypes = (node: unknown, out: string[] = []): string[] => {
    const n = node as { type?: string; children?: unknown[] };
    if (n.type) out.push(n.type);
    for (const c of n.children ?? []) findTypes(c, out);
    return out;
  };

  it('unescaped ||…|| becomes a tgSpoiler node', () => {
    const doc = parseMarkdownDoc('до ||секрет|| после\n');
    expect(findTypes(doc.tree)).toContain('tgSpoiler');
  });

  it('escaped \\|\\|…\\|\\| stays literal text', () => {
    const doc = parseMarkdownDoc('до \\|\\|не секрет\\|\\| после\n');
    expect(findTypes(doc.tree)).not.toContain('tgSpoiler');
  });

  it('==…== becomes mdMark; empty ==== stays literal', () => {
    const withMark = parseMarkdownDoc('текст ==жёлтый== хвост\n');
    expect(findTypes(withMark.tree)).toContain('mdMark');
    const empty = parseMarkdownDoc('линия ==== не метка\n');
    expect(findTypes(empty.tree)).not.toContain('mdMark');
  });

  it('markers inside inline code are untouched', () => {
    const doc = parseMarkdownDoc('код `||не спойлер||` тут\n');
    expect(findTypes(doc.tree)).not.toContain('tgSpoiler');
  });

  it('character reference in the node makes the pass bail out (documented limitation)', () => {
    const doc = parseMarkdownDoc('амп &amp; тут ||секрет||\n');
    // Desync → conservative skip: no split, no corruption, literal text kept.
    expect(findTypes(doc.tree)).not.toContain('tgSpoiler');
  });
});
