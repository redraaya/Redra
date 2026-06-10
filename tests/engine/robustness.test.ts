import { describe, expect, it } from 'vitest';
import { parseDocument, serializeForView, serializeSource } from '../../src/engine/index.js';
import { serializePristine } from '../../src/engine/serialize.js';

describe('robustness on malformed / minimal input', () => {
  it('handles malformed HTML (unclosed tags, stray close tags) without throwing', () => {
    const html = '<div><p>unclosed<span>nested</div></p>stray</div><b>tail';
    const doc = parseDocument(html);
    const src = serializePristine(doc);
    const view = serializeForView(doc);
    expect(src).toContain('unclosed');
    expect(src).toContain('tail');
    expect(view).toContain('data-redra-id');
  });

  it('handles the empty string', () => {
    const doc = parseDocument('');
    // unedited save keeps the original (empty) bytes...
    expect(serializeSource(doc)).toBe('');
    // ...while the parsed tree has the synthesized html/head/body scaffold
    expect(serializePristine(doc)).toContain('<html>');
    expect(serializeForView(doc)).toContain('data-redra-id="r0"');
  });

  it('handles a fragment without doctype/head and stays idempotent', () => {
    const fragment = '<h1>Hello</h1><p>World &amp; co</p>';
    const s1 = serializePristine(parseDocument(fragment));
    expect(s1).toContain('<h1>Hello</h1>');
    expect(s1).toContain('World &amp; co');
    expect(serializePristine(parseDocument(s1))).toBe(s1);
  });

  it('handles whitespace-only and comment-only input', () => {
    expect(() => serializeForView(parseDocument('   \n\t  '))).not.toThrow();
    const doc = parseDocument('<!-- only a comment -->');
    expect(serializeSource(doc)).toContain('<!-- only a comment -->');
  });
});
