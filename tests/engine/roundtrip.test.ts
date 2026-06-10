import { describe, expect, it } from 'vitest';
import { parseDocument, serializeSource } from '../../src/engine/index.js';
import { serializePristine } from '../../src/engine/serialize.js';
import {
  COMMENT_TEXT,
  PRE_TEXT,
  REPORT_HTML,
  SCRIPT_TEXT,
  STYLE_TEXT,
} from './fixtures.js';

describe('serializeSource without ops — verbatim source retention', () => {
  it('returns the original source byte-for-byte', () => {
    expect(serializeSource(parseDocument(REPORT_HTML))).toBe(REPORT_HTML);
  });

  it('does not normalize odd quoting, casing or whitespace', () => {
    const odd =
      '<!doctype HTML>\n<HTML lang=en>\n<head><TITLE>odd</TITLE></head>\n<body>\n' +
      "<P CLASS=unquoted   data-x='single quoted'  >text  with   spaces</p>\n\n" +
      '<div >trailing space inside tag</div >\n<img src=x.png alt=plain>\n' +
      '</body>\n</html>   \n';
    expect(serializeSource(parseDocument(odd))).toBe(odd);
  });
});

describe('round-trip fidelity of the normalization path (serializePristine ∘ parseDocument)', () => {
  const s1 = serializePristine(parseDocument(REPORT_HTML));

  it('preserves the doctype', () => {
    expect(s1.toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });

  it('preserves <style> text byte-for-byte', () => {
    expect(s1).toContain(`<style>${STYLE_TEXT}</style>`);
  });

  it('preserves <script> text byte-for-byte (raw <, &&, quotes)', () => {
    expect(s1).toContain(`<script>${SCRIPT_TEXT}</script>`);
  });

  it('preserves the HTML comment byte-for-byte', () => {
    expect(s1).toContain(`<!--${COMMENT_TEXT}-->`);
  });

  it('preserves <pre> inner text byte-for-byte (whitespace, newlines)', () => {
    // In serialized form "<" is entity-escaped (pre is not a rawtext element)...
    const escaped = PRE_TEXT.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(s1).toContain(`<pre>${escaped}</pre>`);
    // ...and the decoded text node survives byte-for-byte through a reparse.
    const reparsed: any = parseDocument(s1);
    let preText: string | undefined;
    const walk = (node: any): void => {
      for (const child of node.childNodes ?? []) {
        if (child.tagName === 'pre') preText = child.childNodes[0]?.value;
        if (child.content) walk(child.content);
        walk(child);
      }
    };
    walk(reparsed.document);
    expect(preText).toBe(PRE_TEXT);
  });

  it('preserves entities in text content', () => {
    expect(s1).toContain('Q2 Report &amp; Analysis');
    expect(s1).toContain('Revenue grew 5% &lt; forecast, but margin&nbsp;held.');
    expect(s1).toContain('Revenue &amp; fees');
    expect(s1).toContain('Quarterly Report &amp; Outlook');
  });

  it('preserves all attribute values (modulo quote normalization)', () => {
    const original = parseDocument(REPORT_HTML);
    const reparsed = parseDocument(s1);
    const collect = (doc: unknown): Map<string, string> => {
      const out = new Map<string, string>();
      const walk = (node: any): void => {
        for (const child of node.childNodes ?? []) {
          if (child.tagName) {
            for (const attr of child.attrs) {
              out.set(`${child.tagName}[${out.size}]@${attr.name}`, attr.value);
            }
            if (child.content) walk(child.content);
            walk(child);
          }
        }
      };
      walk((doc as any).document);
      return out;
    };
    const a = collect(original);
    const b = collect(reparsed);
    expect(a.size).toBeGreaterThan(10);
    expect(b).toEqual(a);
  });

  it('is idempotent: serializePristine(parseDocument(s1)) === s1', () => {
    const s2 = serializePristine(parseDocument(s1));
    expect(s2).toBe(s1);
  });
});
