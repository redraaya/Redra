import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { renderDocumentBody, isSafeUrl } from '../../src/md/md-render.js';
import { stripForgedStamps } from '../../src/md/md-sanitize.js';

/**
 * Red-team suite for raw-HTML islands in .md files. The renderer emits raw
 * html node values verbatim (minus forged stamps), so EVERYTHING here must
 * be neutralized by the sanitize pass — these are the attacks the
 * adversarial review brief names.
 */

const renderAll = (md: string): string => renderDocumentBody(parseMarkdownDoc(md).blocks);

describe('md-sanitize: dangerous content is dropped', () => {
  it('script blocks vanish with their content', () => {
    const html = renderAll('<script>alert(1)</script>\n\nабзац\n');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('iframe/object/embed vanish', () => {
    const html = renderAll('<iframe src="https://evil"></iframe><object></object><embed>\n');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<object');
    expect(html).not.toContain('<embed');
  });

  it('event handlers are stripped from kept elements', () => {
    const html = renderAll('<div onclick="alert(1)"><b onmouseover="x()">т</b></div>\n');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
  });

  it('javascript: href is stripped', () => {
    const html = renderAll('<a href="javascript:alert(1)">кл</a> текст\n');
    expect(html).not.toContain('javascript:');
  });

  it('style blocks and inline style attributes are stripped', () => {
    const html = renderAll('<style>*{display:none}</style><p style="position:fixed">т</p>\n');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('position:fixed');
  });

  it('svg payloads are dropped', () => {
    const html = renderAll('<svg onload="alert(1)"><circle/></svg>\n');
    expect(html).not.toContain('<svg');
  });
});

describe('md-sanitize: forged stamps cannot hijack ops', () => {
  it('data-redra-id inside raw html is stripped before parsing', () => {
    const html = renderAll('<b data-redra-id="m0">фейк</b> текст\n\nнастоящий\n');
    // The only m0 stamp is the paragraph root emitted by OUR renderer.
    const stamps = [...html.matchAll(/data-redra-id="m0"/g)];
    expect(stamps).toHaveLength(1);
    expect(html).toContain('<p data-redra-id="m0">');
  });

  it('forged r-ids (HTML-doc namespace) and readonly attrs are stripped too', () => {
    expect(stripForgedStamps('<b data-redra-id="r5">x</b>')).not.toContain('data-redra-id');
    expect(stripForgedStamps("<b data-redra-readonly='1'>x</b>")).not.toContain('data-redra-readonly');
    const html = renderAll('<div data-redra-id="c1-2">клон-фейк</div>\n');
    expect(html).not.toContain('c1-2');
  });

  // Red-team (Stage-1): attribute-boundary tricks that the old \sdata-redra-
  // regex missed. Every separator form must still strip the forged stamp.
  it('slash-separated and quote-abutted forged stamps are stripped', () => {
    for (const raw of [
      '<b/data-redra-id="m9">x</b>',
      '<i x="y"data-redra-id="m9">x</i>',
      "<b/data-redra-island='1'>x</b>",
      '<b/data-redra-readonly=1>x</b>',
      '<b DATA-REDRA-ID="m9">x</b>', // case-insensitive
      '<b data-redra-island>x</b>', // valueless boolean
    ]) {
      expect(stripForgedStamps(raw).toLowerCase(), raw).not.toContain('data-redra');
    }
  });

  it('a forged stamp inside a raw-html block cannot collide with a real block id', () => {
    // The <span/data-redra-id="m0"> tried to duplicate the block root id.
    const html = renderAll('<div>\n<span/data-redra-id="m0">hijack</span>\n</div>\n');
    const m0 = [...html.matchAll(/data-redra-id="m0"/g)];
    expect(m0).toHaveLength(1); // only the island wrapper the renderer stamped
  });

  it('split inline tags survive the strip (so block re-parse still pairs them)', () => {
    // <u> and </u> arrive as separate raw-html nodes — stripping must not
    // auto-close the opener.
    const html = renderAll('Слово <u>под</u>чёркнутое.\n');
    expect(html).toContain('<u>под</u>');
  });
});

describe('md-sanitize: URL scheme obfuscation (XSS) is blocked', () => {
  it('control-character-obfuscated javascript: is rejected everywhere', () => {
    const attacks = [
      '<a href="java&#9;script:alert(1)">x</a> t',   // tab in scheme
      '<a href="java&#10;script:alert(1)">x</a> t',  // newline in scheme
      '<a href="&#1;javascript:alert(1)">x</a> t',   // leading control
      '[клик](java&#9;script:alert(1))',             // markdown link
    ];
    for (const md of attacks) {
      const html = renderAll(md + '\n');
      expect(html.toLowerCase(), md).not.toContain('javascript:');
      expect(html, md).not.toContain('java\tscript');
    }
  });

  it('data: image via tab-obfuscated scheme is rejected', () => {
    const html = renderAll('<img src="data&#9;:text/html,<script>alert(1)</script>">\n');
    expect(html).not.toContain('data\t:');
    expect(html).not.toContain('<script>');
  });

  it('isSafeUrl evaluates the browser-stripped form', () => {
    expect(isSafeUrl('java\tscript:alert(1)')).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false);
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('img/a.png')).toBe(true); // relative still safe
    expect(isSafeUrl('mailto:a@b.co')).toBe(true);
  });
});

describe('md-sanitize: islands and editability', () => {
  it('a details/summary island stays EDITABLE (no readonly attr)', () => {
    const html = renderAll('<details><summary>Свернуть</summary><p>внутри</p></details>\n');
    expect(html).toContain('<details');
    expect(html).toContain('data-redra-island');
    expect(html).not.toContain('data-redra-readonly');
  });

  it('an island with unsupported content is marked read-only but keeps visuals', () => {
    const html = renderAll('<div class="widget"><table><tr><td>х</td></tr></table></div>\n');
    expect(html).toContain('data-redra-readonly="1"');
    expect(html).toContain('<table'); // content still visible
  });

  it('inline <u> inside a paragraph is NOT an island — plain editable inline', () => {
    const html = renderAll('Слово <u>тут</u> инлайн.\n');
    expect(html).not.toContain('data-redra-island');
    expect(html).toContain('<u>тут</u>');
  });

  it('unknown harmless classes are stripped; language-* survives', () => {
    const html = renderAll('<p class="hero xl">т</p>\n\n```go\nx\n```\n');
    expect(html).not.toContain('hero');
    expect(html).toContain('language-go');
  });

  it('ol start survives only as digits', () => {
    const html = renderAll('<ol start="7"><li>а</li></ol>\n\n<ol start="7); DROP">\n<li>б</li>\n</ol>\n');
    expect(html).toContain('start="7"');
    expect(html).not.toContain('DROP');
  });
});
