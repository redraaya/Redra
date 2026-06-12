import { describe, expect, it } from 'vitest';
import {
  HEAVY_STAMPED_ATTR_LIMIT,
  normalizeEditedHtml,
  stubHeavyStampedAttrs,
} from '../../src/engine/normalize.js';
import { getElementById, parseDocument, serializeSource } from '../../src/engine/index.js';
import type { Op, RedraDoc } from '../../src/engine/index.js';

/**
 * stubHeavyStampedAttrs: the editText wire payload must not carry multi-MB
 * attribute values (a replaced image's data: URI) — they would blow the
 * 2 MB editText cap and bounce the user's TEXT edit. The data URI in the
 * payload is dead weight anyway: the provenance gate replaces a verified
 * stamped element's live attributes with the ones from the (ops-applied)
 * source, so the journal's setAttr op is what reaches the saved file.
 */

const BIG = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024); // ~5 MB

describe('stubHeavyStampedAttrs (wire-payload slimming)', () => {
  it('stubs a heavy attr value on a STAMPED element to ""', () => {
    const html = `text <img data-redra-id="r7" src="${BIG}" alt="диаграмма"> tail`;
    const out = stubHeavyStampedAttrs(html);
    expect(out).toBe('text <img data-redra-id="r7" src="" alt="диаграмма"> tail');
    expect(out.length).toBeLessThan(1024);
  });

  it('leaves attrs at exactly the limit untouched (strictly-greater rule)', () => {
    const atLimit = 'x'.repeat(HEAVY_STAMPED_ATTR_LIMIT);
    const html = `<img data-redra-id="r7" src="${atLimit}">`;
    expect(stubHeavyStampedAttrs(html)).toBe(html);
  });

  it('does not touch UNSTAMPED elements (provenance gate never restores their attrs)', () => {
    const html = `<img src="${BIG}">`;
    expect(stubHeavyStampedAttrs(html)).toBe(html);
  });

  it('reaches stamped elements nested inside unstamped wrappers', () => {
    const html = `<span><img data-redra-id="r9" src="${BIG}"></span>`;
    expect(stubHeavyStampedAttrs(html)).toBe('<span><img data-redra-id="r9" src=""></span>');
  });

  it('keeps text, small attrs and structure byte-identical when nothing is heavy', () => {
    const html =
      'привет <b data-redra-id="r6">мир</b> <a href="https://x.y/z">ссылка</a> <!--gone by normalize, kept here-->';
    expect(stubHeavyStampedAttrs(html)).toBe(html);
  });

  it('never descends into stamped <template> content (verbatim byte-check must keep passing)', () => {
    const inner = `<img data-redra-id="r3" src="${'y'.repeat(HEAVY_STAMPED_ATTR_LIMIT + 10)}">`;
    const html = `<template data-redra-id="r2">${inner}</template>`;
    expect(stubHeavyStampedAttrs(html)).toBe(html);
  });

  it('is idempotent', () => {
    const html = `a <img data-redra-id="r7" src="${BIG}"> b`;
    const once = stubHeavyStampedAttrs(html);
    expect(stubHeavyStampedAttrs(once)).toBe(once);
  });
});

describe('replaced image + later text edit (integration through the provenance gate)', () => {
  const SRC = `<!DOCTYPE html>
<html><head></head><body>
<div id="card"><p id="txt">подпись <img id="pic" src="old.png" alt="график"></p></div>
</body></html>
`;

  function rid(doc: RedraDoc, domId: string): string {
    for (let i = 0; ; i++) {
      const el = getElementById(doc, `r${i}`);
      if (!el) throw new Error(`no element with id="${domId}" in fixture`);
      if (el.attrs.some((a) => a.name === 'id' && a.value === domId)) return `r${i}`;
    }
  }

  it('saved file carries the REAL data URI from setAttr while the editText payload was stubbed', () => {
    const doc = parseDocument(SRC);
    const pic = rid(doc, 'pic');
    const txt = rid(doc, 'txt');

    // What the live DOM looks like after image replace + a text edit: the
    // commit pipeline normalizes and then stubs the heavy stamped src.
    const live = `подпись изменена <img id="pic" src="${BIG}" alt="график" data-redra-id="${pic}">`;
    const payload = stubHeavyStampedAttrs(normalizeEditedHtml(live));
    expect(payload).toContain('src=""');
    expect(payload.length).toBeLessThan(1024);

    const ops: Op[] = [
      { type: 'setAttr', id: pic, name: 'src', value: BIG },
      { type: 'editText', id: txt, html: payload },
    ];
    const saved = serializeSource(doc, ops);

    expect(saved).toContain('подпись изменена');
    expect(saved).toContain(`src="${BIG}"`); // the journal's setAttr survived the gate
    expect(saved).toContain('alt="график"');
    expect(saved).not.toContain('data-redra-id');
  });
});
