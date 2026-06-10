import { describe, expect, it } from 'vitest';
import { getElementById, getElementId, parseDocument } from '../../src/engine/index.js';
import { REPORT_HTML } from './fixtures.js';

describe('id <-> node lookup', () => {
  it('getElementById and getElementId are inverses for a sample of ids', () => {
    const doc = parseDocument(REPORT_HTML);
    let found = 0;
    for (let i = 0; i < 200; i++) {
      const id = `r${i}`;
      const node = getElementById(doc, id);
      if (node === undefined) continue;
      found++;
      expect(getElementId(doc, node)).toBe(id);
    }
    expect(found).toBeGreaterThan(20);
  });

  it('ids are assigned densely from r0 in document order', () => {
    const doc = parseDocument(REPORT_HTML);
    const html = getElementById(doc, 'r0') as { tagName?: string };
    expect(html?.tagName).toBe('html');
    const head = getElementById(doc, 'r1') as { tagName?: string };
    expect(head?.tagName).toBe('head');
  });

  it('returns undefined for unknown ids and foreign nodes', () => {
    const doc = parseDocument(REPORT_HTML);
    expect(getElementById(doc, 'r999999')).toBeUndefined();
    expect(getElementById(doc, 'nonsense')).toBeUndefined();
    expect(getElementId(doc, { tagName: 'div' })).toBeUndefined();
    expect(getElementId(doc, null)).toBeUndefined();
  });

  it('nodes from a different doc of the same source do not collide', () => {
    const doc1 = parseDocument(REPORT_HTML);
    const doc2 = parseDocument(REPORT_HTML);
    const node1 = getElementById(doc1, 'r5');
    expect(node1).toBeDefined();
    // same id exists in doc2, but doc1's node is not a member of doc2's maps
    expect(getElementId(doc2, node1)).toBeUndefined();
  });
});
