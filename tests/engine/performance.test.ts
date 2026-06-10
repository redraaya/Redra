import { describe, expect, it } from 'vitest';
import {
  getElementById,
  parseDocument,
  serializeForView,
  serializeSource,
  type Op,
} from '../../src/engine/index.js';
import { serializePristine } from '../../src/engine/serialize.js';

function generateBigReport(targetBytes: number): string {
  const parts: string[] = [
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Big</title>',
    '<style>body { margin: 0; } section { padding: 1em; }</style></head><body>',
  ];
  let size = parts.join('').length;
  let i = 0;
  while (size < targetBytes) {
    const section =
      `<section id="s${i}" class="block"><h2>Section ${i} &amp; friends</h2>` +
      `<p>Paragraph with <b>bold</b>, <i>italic</i> and a <a href="#s${i}">link ${i}</a>.</p>` +
      `<table><tr><td>cell ${i}</td><td>${i * 2}</td></tr></table></section>\n`;
    parts.push(section);
    size += section.length;
    i++;
  }
  parts.push('</body></html>');
  return parts.join('');
}

describe('performance smoke', () => {
  it('parse + serializeForView + serializePristine of ~1 MB under 1000 ms', () => {
    const html = generateBigReport(1_000_000);
    expect(html.length).toBeGreaterThanOrEqual(1_000_000);

    const t0 = performance.now();
    const doc = parseDocument(html);
    const t1 = performance.now();
    const view = serializeForView(doc);
    const t2 = performance.now();
    const src = serializePristine(doc);
    const t3 = performance.now();

    const parseMs = t1 - t0;
    const viewMs = t2 - t1;
    const sourceMs = t3 - t2;
    const totalMs = t3 - t0;
    console.log(
      `perf (~${(html.length / 1e6).toFixed(2)} MB): parse=${parseMs.toFixed(1)}ms ` +
        `serializeForView=${viewMs.toFixed(1)}ms serializePristine=${sourceMs.toFixed(1)}ms ` +
        `total=${totalMs.toFixed(1)}ms`,
    );

    expect(view).toContain('data-redra-id');
    expect(src).not.toContain('data-redra-id');
    expect(totalMs).toBeLessThan(1000);
  });

  it('serializeSource with 200 mixed ops on a ~1 MB doc under 500 ms', () => {
    const html = generateBigReport(1_000_000);
    const doc = parseDocument(html);

    // collect ids of <section> elements (one per block, plenty of them)
    const sectionIds: string[] = [];
    for (let i = 0; ; i++) {
      const el = getElementById(doc, `r${i}`);
      if (!el) break;
      if (el.tagName === 'section') sectionIds.push(`r${i}`);
    }
    expect(sectionIds.length).toBeGreaterThan(600);

    // 200 mixed ops, each on its own section — no conflicts
    const ops: Op[] = [];
    for (let k = 0; k < 200; k++) {
      const id = sectionIds[k]!;
      if (k % 3 === 0) {
        ops.push({ type: 'editText', id, html: `<h2>Edited ${k}</h2><p>new <b>content</b></p>` });
      } else if (k % 3 === 1) {
        ops.push({ type: 'moveBlock', id, beforeId: null });
      } else {
        ops.push({ type: 'deleteBlock', id });
      }
    }

    const t0 = performance.now();
    const out = serializeSource(doc, ops);
    const elapsed = performance.now() - t0;
    console.log(`perf ops: serializeSource(~1 MB, 200 ops)=${elapsed.toFixed(1)}ms`);

    expect(out).toContain('Edited 0');
    expect(out).not.toContain('data-redra-id');
    expect(elapsed).toBeLessThan(500);
  });
});
