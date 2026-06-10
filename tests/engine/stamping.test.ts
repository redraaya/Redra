import { describe, expect, it } from 'vitest';
import { parseDocument, serializeForView, serializeSource } from '../../src/engine/index.js';
import { REPORT_HTML } from './fixtures.js';

/**
 * Count opening tags. Script bodies are emptied first: raw JS like
 * "a < threshold && b > 0" would otherwise look like a tag to the regex.
 */
function countOpeningTags(html: string): number {
  const noScriptBodies = html.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');
  return (noScriptBodies.match(/<[a-zA-Z][^>]*>/g) ?? []).length;
}

function extractIds(html: string): string[] {
  return [...html.matchAll(/data-redra-id="(r\d+)"/g)].map((m) => m[1]!);
}

describe('serializeForView stamping', () => {
  it('stamps every element with data-redra-id', () => {
    const view = serializeForView(parseDocument(REPORT_HTML));
    expect(countOpeningTags(view)).toBe(extractIds(view).length);
  });

  it('assigns unique ids of the form rN', () => {
    const ids = extractIds(serializeForView(parseDocument(REPORT_HTML)));
    expect(ids.length).toBeGreaterThan(20);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^r\d+$/);
  });

  it('stamps template content elements too', () => {
    const view = serializeForView(parseDocument(REPORT_HTML));
    expect(view).toMatch(/<tr class="row" data-redra-id="r\d+"><td data-redra-id="r\d+">placeholder/);
  });

  it('is deterministic: same input parsed twice yields identical view output', () => {
    const v1 = serializeForView(parseDocument(REPORT_HTML));
    const v2 = serializeForView(parseDocument(REPORT_HTML));
    expect(v1).toBe(v2);
  });

  it('leaves the pristine tree unstamped (serializeSource after serializeForView)', () => {
    const doc = parseDocument(REPORT_HTML);
    const before = serializeSource(doc);
    serializeForView(doc);
    const after = serializeSource(doc);
    expect(after).toBe(before);
    expect(after).not.toContain('data-redra-id');
  });

  it('serializeForView is repeatable on the same doc', () => {
    const doc = parseDocument(REPORT_HTML);
    expect(serializeForView(doc)).toBe(serializeForView(doc));
  });

  it('preserves a pre-existing data-redra-id attribute in the source', () => {
    const html = '<!DOCTYPE html><html><head></head><body><div data-redra-id="legacy">x</div></body></html>';
    const doc = parseDocument(html);
    const view = serializeForView(doc);
    // In the view, our id wins (overrides the source value)...
    expect(view).toMatch(/<div data-redra-id="r\d+">x<\/div>/);
    // ...but the pristine source keeps the original value.
    expect(serializeSource(doc)).toContain('<div data-redra-id="legacy">x</div>');
  });
});
