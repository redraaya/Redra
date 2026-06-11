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
 * bottom runs over all of them, so new fixtures must be registered via fx().
 *
 * Stamped fixtures (inputs containing data-redra-id) ARE in this list:
 * normalizeEditedHtml keeps the stamps in its output (they are provenance
 * claims for applyOps), so re-normalizing takes the same passthrough branch
 * and the function is idempotent over both modes.
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

  it('a STAMPED <b> is original markup: class AND stamp survive (the stamp is the provenance claim for applyOps)', () => {
    expect(normalizeEditedHtml(fx('<b class="x" data-redra-id="r4">text</b>'))).toBe(
      '<b class="x" data-redra-id="r4">text</b>',
    );
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

  it('keeps stamps on stamped elements untouched — they are claims, verified later by applyOps against the pristine source', () => {
    const raw = fx(
      '<b data-redra-id="r1">a</b><a data-redra-id="r2" href="https://e.com">l</a>' +
        '<span data-redra-id="r3"><i data-redra-id="r4">i</i></span>',
    );
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });
});

describe('normalizeEditedHtml: STAMPED elements pass through AS-IS (stamp included)', () => {
  it('keeps a class-styled badge span in a table cell after typing one letter (field report)', () => {
    const raw = fx('<span class="tag a" data-redra-id="r7">AYX</span>');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('keeps a badge span when new text is typed NEXT to it in the cell', () => {
    const raw = fx('<span class="tag a" data-redra-id="r7">AY</span> ok');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('a stamped nested <ul> inside an edited <li> survives as a real list, not <br>s', () => {
    const raw = fx('one<ul data-redra-id="r5"><li data-redra-id="r6">sub</li></ul>');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('a stamped div keeps its tag and class — no <br> conversion for original blocks', () => {
    const raw = fx('a<div data-redra-id="r2" class="box">b</div>');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('a stamped img keeps its relative src', () => {
    const raw = fx('<img data-redra-id="r3" src="img/chart.png" alt="график" width="40">');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('LIVE attributes survive untouched, suspicious ones included — applyOps replaces them with the verified originals anyway', () => {
    const raw = fx('<img data-redra-id="r3" src="javascript:alert(1)" alt="x">');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('a stamped a with a data: href keeps it for the gate to judge', () => {
    const raw = fx('<a data-redra-id="r3" href="data:text/html,x" class="lnk">x</a>');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('on* handlers stay on stamped elements — provenance is verified by applyOps, not here', () => {
    const raw = fx(
      '<div data-redra-id="r2" onclick="evil()" onmouseover="evil()" class="c" id="z">x</div>',
    );
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('a stamped table keeps its full structure and attributes', () => {
    const raw = fx(
      '<table data-redra-id="r1" border="1"><tbody data-redra-id="r2">' +
        '<tr data-redra-id="r3"><td data-redra-id="r4" colspan="2">a</td></tr>' +
        '</tbody></table>',
    );
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('a stamped <style> keeps its content verbatim, stamp included', () => {
    const raw = fx('<style data-redra-id="r8">.tag{color:red}</style>x');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('a stamped <script> keeps its content verbatim, stamp included', () => {
    const raw = fx('<script data-redra-id="r8">draw();</script>x');
    expect(normalizeEditedHtml(raw)).toBe(raw);
  });

  it('an UNSTAMPED script next to a stamped one is still dropped', () => {
    expect(
      normalizeEditedHtml(fx('<script data-redra-id="r8">draw();</script><script>evil()</script>')),
    ).toBe('<script data-redra-id="r8">draw();</script>');
  });

  it('new unstamped junk INSIDE a stamped block is still cleaned by the whitelist', () => {
    expect(
      normalizeEditedHtml(
        fx('<div data-redra-id="r2" class="box"><span style="font-weight:700">t</span></div>'),
      ),
    ).toBe('<div data-redra-id="r2" class="box">t</div>');
  });

  it('a new style-span WRAPPING a stamped <b> unwraps; the b keeps its attrs and stamp', () => {
    expect(
      normalizeEditedHtml(
        fx('<span style="color:red"><b data-redra-id="r4" class="k">x</b></span>'),
      ),
    ).toBe('<b data-redra-id="r4" class="k">x</b>');
  });

  it('stamps survive at every depth (forged ones are downgraded later, in applyOps)', () => {
    const raw = fx(
      '<div data-redra-id="r1"><span data-redra-id="r2"><i data-redra-id="r3">x</i></span></div>',
    );
    expect(normalizeEditedHtml(raw)).toBe(raw);
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

describe('normalizeEditedHtml: non-div/p blocks also become <br> lines', () => {
  it('list items become lines: ul/li unwrap with a <br> between items', () => {
    expect(normalizeEditedHtml(fx('<ul><li>one</li><li>two</li></ul>'))).toBe('one<br>two');
  });

  it('nested lists keep every item on its own line', () => {
    expect(
      normalizeEditedHtml(fx('<ul><li>one<ul><li>sub</li></ul></li><li>two</li></ul>')),
    ).toBe('one<br>sub<br>two');
  });

  it('INTERPRETATION: only <tr> breaks a line — td/th unwrap inline, so cells of one row concatenate', () => {
    expect(normalizeEditedHtml(fx('x<table><tr><td>a</td><td>b</td></tr></table>'))).toBe(
      'x<br>ab',
    );
  });

  it('a heading breaks the line BEFORE itself, and the following <p> breaks after', () => {
    expect(normalizeEditedHtml(fx('intro<h1>Title</h1><p>para</p>'))).toBe(
      'intro<br>Title<br>para',
    );
  });

  it('INTERPRETATION: blocks break before themselves only — inline text right after a blockquote continues its line (same rule as div)', () => {
    expect(normalizeEditedHtml(fx('a<blockquote>q</blockquote>b'))).toBe('a<br>qb');
  });

  it('<hr> is an empty line-break block: unwrapping it yields a bare <br>', () => {
    expect(normalizeEditedHtml(fx('a<hr>b'))).toBe('a<br>b');
  });

  it('a block inside an unwrapped inline wrapper still sees the preceding text across levels', () => {
    expect(normalizeEditedHtml(fx('text<span><div>line</div></span>'))).toBe('text<br>line');
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
    // All junk here is UNSTAMPED (new content typed/pasted into the session).
    const raw =
      '<span style="color:red">new</span>' +
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

  it('an edited td keeps its badge span (file\'s own markup) in the SAVED file', () => {
    const doc = parseDocument(
      '<!DOCTYPE html><html><head><title>t</title></head><body>' +
        '<table><tr><td><span class="tag a">AY</span></td></tr></table>' +
        '</body></html>',
    );
    // The live DOM serves the STAMPED copy: the original span carries the
    // stamp, the typed letter appears as plain text inside it. The stamp
    // rides INSIDE the op payload — applyOps verifies it against the
    // pristine source and swaps in the original attributes.
    const spanId = tagId(doc, 'span');
    const raw = `<span class="tag a" data-redra-id="${spanId}">AYX</span>`;
    const html = normalizeEditedHtml(raw);
    expect(html).toBe(raw);

    const ops: Op[] = [{ type: 'editText', id: tagId(doc, 'td'), html }];
    const saved = serializeSource(doc, ops);
    expect(saved).toContain('<td><span class="tag a">AYX</span></td>');
    expect(saved).not.toContain('data-redra-id');
  });
});
