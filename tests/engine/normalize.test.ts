import { describe, expect, it } from 'vitest';
import {
  getElementById,
  normalizeEditedHtml,
  parseDocument,
  serializeSource,
  type Element,
  type Op,
  type RedraDoc,
} from '../../src/engine/index.js';

/**
 * Every raw input used anywhere in this file. The idempotence suite at the
 * bottom runs over all of them, so new fixtures must be added here.
 */
const FIXTURES: string[] = [];

/** Register a fixture for the idempotence loop and return it. */
function fx(raw: string): string {
  FIXTURES.push(raw);
  return raw;
}

describe('normalizeEditedHtml: allowed elements and attributes', () => {
  it('drops a Chrome-paste styled span, keeps its text (b is NOT synthesized from font-weight — style mapping is out of scope in v1)', () => {
    expect(
      normalizeEditedHtml(fx('<span style="font-weight:700; color: rgb(34,34,34)">bold</span>')),
    ).toBe('bold');
  });

  it('strips class and data-redra-id from a kept <b>', () => {
    expect(normalizeEditedHtml(fx('<b class="x" data-redra-id="r4">text</b>'))).toBe('<b>text</b>');
  });

  it('strips every attribute from kept formatting tags', () => {
    expect(
      normalizeEditedHtml(
        fx('<strong id="q" style="color:red">s</strong><em data-foo="1">e</em><i lang="en">i</i>'),
      ),
    ).toBe('<strong>s</strong><em>e</em><i>i</i>');
  });

  it('unwraps font, keeps u/s/mark/sub/sup/code bare', () => {
    expect(
      normalizeEditedHtml(
        fx(
          '<font color="red" face="Arial">f</font><u class="a">u</u><s>s</s>' +
            '<mark style="background:lime">m</mark><sub>1</sub><sup>2</sup><code class="hl">c</code>',
        ),
      ),
    ).toBe('f<u>u</u><s>s</s><mark>m</mark><sub>1</sub><sup>2</sup><code>c</code>');
  });

  it('keeps UPPERCASE legacy tags, lowercased by parse5', () => {
    expect(normalizeEditedHtml(fx('<B>x</B><EM>y</EM>'))).toBe('<b>x</b><em>y</em>');
  });

  it('unwraps unknown/disallowed wrappers recursively', () => {
    expect(
      normalizeEditedHtml(fx('<span><span style="x:y"><b>deep</b> text</span></span>')),
    ).toBe('<b>deep</b> text');
  });

  it('never lets data-redra-id survive on any kept element (fragments come from the stamped live DOM)', () => {
    const out = normalizeEditedHtml(
      fx(
        '<b data-redra-id="r1">a</b><a data-redra-id="r2" href="https://e.com">l</a>' +
          '<span data-redra-id="r3"><i data-redra-id="r4">i</i></span>',
      ),
    );
    expect(out).toBe('<b>a</b><a href="https://e.com">l</a><i>i</i>');
    expect(out).not.toContain('data-redra-id');
  });
});

describe('normalizeEditedHtml: block boundaries become <br>', () => {
  it('turns per-line divs into <br> separators', () => {
    expect(normalizeEditedHtml(fx('first<div>second</div><div>third</div>'))).toBe(
      'first<br>second<br>third',
    );
  });

  it('a single leading div has nothing before it, so no <br>', () => {
    expect(normalizeEditedHtml(fx('<div>a</div>'))).toBe('a');
  });

  it('an empty-line div (<div><br></div>) yields at most two consecutive <br>', () => {
    expect(normalizeEditedHtml(fx('a<div><br></div><div>b</div>'))).toBe('a<br><br>b');
  });

  it('a run of empty-line divs still collapses to exactly two <br>', () => {
    expect(
      normalizeEditedHtml(fx('a<div><br></div><div><br></div><div><br></div><div>b</div>')),
    ).toBe('a<br><br>b');
  });

  it('unwraps <p> blocks with the same <br> rule', () => {
    expect(normalizeEditedHtml(fx('<p>one</p><p>two</p>'))).toBe('one<br>two');
  });

  it('handles nested divs: outer unwrap then inner lines', () => {
    expect(normalizeEditedHtml(fx('x<div><div>a</div><div>b</div></div>'))).toBe('x<br>a<br>b');
  });

  it('INTERPRETATION: a removed element before a div does not count as preceding content (no spurious <br> for invisible junk)', () => {
    expect(normalizeEditedHtml(fx('<script>x()</script><div>a</div>'))).toBe('a');
  });

  it('INTERPRETATION: whitespace-only preceding text does not trigger a <br> (renders as nothing at a block boundary)', () => {
    expect(normalizeEditedHtml(fx('\n  <div>a</div>'))).toBe('\n  a');
  });

  it('INTERPRETATION: br-collapsing merges only strictly adjacent <br> nodes — text between them is never deleted', () => {
    expect(normalizeEditedHtml(fx('a<br><br>x<br><br>b'))).toBe('a<br><br>x<br><br>b');
  });
});

describe('normalizeEditedHtml: links', () => {
  it('keeps https href, strips other attributes', () => {
    expect(
      normalizeEditedHtml(
        fx('<a href="https://example.com/p?q=1" target="_blank" rel="noopener" class="c">go</a>'),
      ),
    ).toBe('<a href="https://example.com/p?q=1">go</a>');
  });

  it('keeps http, mailto, tel hrefs', () => {
    expect(
      normalizeEditedHtml(
        fx(
          '<a href="http://e.com">h</a><a href="mailto:a@b.c">m</a><a href="tel:+1234">t</a>',
        ),
      ),
    ).toBe('<a href="http://e.com">h</a><a href="mailto:a@b.c">m</a><a href="tel:+1234">t</a>');
  });

  it('keeps relative and anchor hrefs (#, /, ./, ../, bare path)', () => {
    expect(
      normalizeEditedHtml(
        fx(
          '<a href="#top">1</a><a href="/abs">2</a><a href="./rel">3</a>' +
            '<a href="../up">4</a><a href="page.html">5</a>',
        ),
      ),
    ).toBe(
      '<a href="#top">1</a><a href="/abs">2</a><a href="./rel">3</a>' +
        '<a href="../up">4</a><a href="page.html">5</a>',
    );
  });

  it('drops javascript: href but keeps the <a>', () => {
    expect(normalizeEditedHtml(fx('<a href="javascript:alert(1)">x</a>'))).toBe('<a>x</a>');
  });

  it('drops javascript: in mixed case', () => {
    expect(normalizeEditedHtml(fx('<a href="JaVaScRiPt:alert(1)">x</a>'))).toBe('<a>x</a>');
  });

  it('drops javascript: with leading space, newline, tab', () => {
    expect(normalizeEditedHtml(fx('<a href=" javascript:alert(1)">a</a>'))).toBe('<a>a</a>');
    expect(normalizeEditedHtml(fx('<a href="\njavascript:alert(1)">b</a>'))).toBe('<a>b</a>');
    expect(normalizeEditedHtml(fx('<a href="\tjavascript:alert(1)">c</a>'))).toBe('<a>c</a>');
  });

  it('drops javascript: with tab/newline embedded inside the scheme (HTML URL parser strips them)', () => {
    expect(normalizeEditedHtml(fx('<a href="java\tscript:alert(1)">x</a>'))).toBe('<a>x</a>');
    expect(normalizeEditedHtml(fx('<a href="java\nscript:alert(1)">y</a>'))).toBe('<a>y</a>');
  });

  it('drops javascript: when entity-encoded in the source (parse5 decodes attribute entities)', () => {
    expect(normalizeEditedHtml(fx('<a href="&#106;avascript:alert(1)">x</a>'))).toBe('<a>x</a>');
  });

  it('drops data: and vbscript: schemes', () => {
    expect(
      normalizeEditedHtml(
        fx('<a href="data:text/html,<b>x</b>">d</a><a href="vbscript:msgbox">v</a>'),
      ),
    ).toBe('<a>d</a><a>v</a>');
  });

  it('processes nested formatting inside <a>', () => {
    expect(
      normalizeEditedHtml(
        fx('<a href="https://e.com"><span style="font-weight:700">in</span> <b class="c">b</b></a>'),
      ),
    ).toBe('<a href="https://e.com">in <b>b</b></a>');
  });
});

describe('normalizeEditedHtml: dangerous content removed entirely', () => {
  it('removes script with its content', () => {
    expect(normalizeEditedHtml(fx('before<script>evil()</script>after'))).toBe('beforeafter');
  });

  it('removes style with its content', () => {
    expect(normalizeEditedHtml(fx('<style>p{color:red}</style>text'))).toBe('text');
  });

  it('removes iframe with its fallback content', () => {
    expect(normalizeEditedHtml(fx('a<iframe src="https://x.y">fallback</iframe>b'))).toBe('ab');
  });

  it('removes template entirely, including its content', () => {
    expect(normalizeEditedHtml(fx('<template><b>hidden</b></template>z'))).toBe('z');
  });

  it('removes object, embed, link, meta', () => {
    expect(
      normalizeEditedHtml(
        fx('<object data="x">o</object><embed src="y"><link rel="stylesheet" href="z"><meta charset="utf-8">t'),
      ),
    ).toBe('t');
  });

  it('removes comments', () => {
    expect(normalizeEditedHtml(fx('a<!-- secret -->b'))).toBe('ab');
  });
});

describe('normalizeEditedHtml: text fidelity', () => {
  it('preserves entities (&amp;, &nbsp;) through the round-trip', () => {
    expect(normalizeEditedHtml(fx('a&amp;b and a&nbsp;b'))).toBe('a&amp;b and a&nbsp;b');
  });

  it('does not collapse whitespace: a run of double spaces survives', () => {
    expect(normalizeEditedHtml(fx('two  spaces  kept'))).toBe('two  spaces  kept');
  });

  it('empty input stays empty', () => {
    expect(normalizeEditedHtml(fx(''))).toBe('');
  });

  it('whitespace-only input survives unchanged', () => {
    expect(normalizeEditedHtml(fx('  \n '))).toBe('  \n ');
  });
});

describe('normalizeEditedHtml: idempotence', () => {
  it('normalizing twice equals normalizing once, for every fixture in this file', () => {
    expect(FIXTURES.length).toBeGreaterThan(30);
    for (const raw of FIXTURES) {
      const once = normalizeEditedHtml(raw);
      expect(normalizeEditedHtml(once), `fixture: ${JSON.stringify(raw)}`).toBe(once);
    }
  });
});

describe('normalizeEditedHtml: integration with editText/serializeSource', () => {
  /** Resolve the rN id of the first element with the given tag name. */
  function tagId(doc: RedraDoc, tagName: string): string {
    for (let i = 0; ; i++) {
      const el: Element | undefined = getElementById(doc, `r${i}`);
      if (!el) throw new Error(`no <${tagName}> in fixture`);
      if (el.tagName === tagName) return `r${i}`;
    }
  }

  it('normalized contenteditable output flows into a clean saved file', () => {
    const doc = parseDocument(
      '<!DOCTYPE html><html><head><title>t</title></head><body><p id="msg">old</p></body></html>',
    );
    const raw =
      '<span style="color:red" data-redra-id="r9">new</span>' +
      '<div><font face="Arial">second <b class="x">line</b></font></div>';
    const html = normalizeEditedHtml(raw);
    expect(html).toBe('new<br>second <b>line</b>');

    const ops: Op[] = [{ type: 'editText', id: tagId(doc, 'p'), html }];
    const saved = serializeSource(doc, ops);
    expect(saved).toContain('<p id="msg">new<br>second <b>line</b></p>');
    expect(saved).not.toContain('span');
    expect(saved).not.toContain('style=');
    expect(saved).not.toContain('data-redra-id');
    expect(saved).not.toContain('font');
  });
});
