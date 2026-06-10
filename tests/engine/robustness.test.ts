import { describe, expect, it } from 'vitest';
import { parseDocument, serializeForView, serializeSource } from '../../src/engine/index.js';

describe('robustness on malformed / minimal input', () => {
  it('handles malformed HTML (unclosed tags, stray close tags) without throwing', () => {
    const html = '<div><p>unclosed<span>nested</div></p>stray</div><b>tail';
    const doc = parseDocument(html);
    const src = serializeSource(doc);
    const view = serializeForView(doc);
    expect(src).toContain('unclosed');
    expect(src).toContain('tail');
    expect(view).toContain('data-redra-id');
  });

  it('handles the empty string', () => {
    const doc = parseDocument('');
    const src = serializeSource(doc);
    // parse5 synthesizes the html/head/body scaffold
    expect(src).toContain('<html>');
    expect(serializeForView(doc)).toContain('data-redra-id="r0"');
  });

  it('handles a fragment without doctype/head and stays idempotent', () => {
    const fragment = '<h1>Hello</h1><p>World &amp; co</p>';
    const s1 = serializeSource(parseDocument(fragment));
    expect(s1).toContain('<h1>Hello</h1>');
    expect(s1).toContain('World &amp; co');
    expect(serializeSource(parseDocument(s1))).toBe(s1);
  });

  it('handles whitespace-only and comment-only input', () => {
    expect(() => serializeForView(parseDocument('   \n\t  '))).not.toThrow();
    const doc = parseDocument('<!-- only a comment -->');
    expect(serializeSource(doc)).toContain('<!-- only a comment -->');
  });
});
