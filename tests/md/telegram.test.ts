import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { toMarkdownV2 } from '../../src/md/telegram/to-markdownv2.js';
import { toTelegramHtml } from '../../src/md/telegram/to-html.js';
import { escapeV2 } from '../../src/md/telegram/escaper.js';

const mv2 = (md: string): string => toMarkdownV2(parseMarkdownDoc(md).tree);
const tgHtml = (md: string): string => toTelegramHtml(parseMarkdownDoc(md).tree);

describe('MarkdownV2 escaper', () => {
  it('escapes all 18 special characters outside entities', () => {
    expect(escapeV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s')).toBe(
      'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s',
    );
  });
});

describe('mdast → MarkdownV2 (Telegram classic composer)', () => {
  it('bold uses * (not **), italic uses _', () => {
    expect(mv2('**жирный** и *курсив*\n')).toBe('*жирный* и _курсив_');
  });
  it('strikethrough uses a SINGLE tilde', () => {
    expect(mv2('~~зачёркнутый~~\n')).toBe('~зачёркнутый~');
  });
  it('spoiler stays ||…||', () => {
    expect(mv2('тут ||секрет|| да\n')).toBe('тут ||секрет|| да');
  });
  it('underline <u> becomes __…__', () => {
    expect(mv2('вот <u>подчёркнуто</u> тут\n')).toBe('вот __подчёркнуто__ тут');
  });
  it('inline code escapes only backticks/backslashes', () => {
    expect(mv2('`a.b-c`\n')).toBe('`a.b-c`');
  });
  it('a heading flattens to a bold line', () => {
    expect(mv2('# Заголовок\n')).toBe('*Заголовок*');
  });
  it('a link with special chars in text is escaped, url is angle-safe', () => {
    expect(mv2('[текст.тут](https://e.com/a)\n')).toBe('[текст\\.тут](https://e.com/a)');
  });
  it('lists render as bullets / numbers', () => {
    expect(mv2('- раз\n- два\n')).toBe('• раз\n• два');
    expect(mv2('1. раз\n2. два\n')).toBe('1\\. раз\n2\\. два');
  });
  it('a paragraph escapes literal dots and dashes', () => {
    expect(mv2('Версия 1.0 - готово!\n')).toBe('Версия 1\\.0 \\- готово\\!');
  });
  it('a code block keeps its language and does not escape body dots', () => {
    expect(mv2('```js\nconst a = 1.0;\n```\n')).toBe('```js\nconst a = 1.0;\n```');
  });
  it('drops an unsafe link scheme', () => {
    // eslint-disable-next-line no-script-url
    expect(mv2('[x](javascript:alert(1))\n')).not.toContain('javascript:');
  });
});

describe('mdast → Telegram HTML parse-mode', () => {
  it('emits b/i/s/tg-spoiler and escapes text', () => {
    expect(tgHtml('**ж** *к* ~~з~~ ||с||\n')).toBe('<b>ж</b> <i>к</i> <s>з</s> <tg-spoiler>с</tg-spoiler>');
  });
  it('heading → <b>, code → <pre><code>', () => {
    expect(tgHtml('# H\n')).toBe('<b>H</b>');
    expect(tgHtml('```py\nx\n```\n')).toBe('<pre><code class="language-py">x</code></pre>');
  });
  it('escapes < > & in text', () => {
    expect(tgHtml('a < b & c > d\n')).toBe('a &lt; b &amp; c &gt; d');
  });
  it('link with safe url', () => {
    expect(tgHtml('[t](https://e.com)\n')).toBe('<a href="https://e.com">t</a>');
  });
});
