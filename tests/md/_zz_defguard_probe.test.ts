import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { serializeMdSource, tryApplyMdOps } from '../../src/md/md-ops.js';
import { guardMdPush } from '../../src/md/md-op-guard.js';
import { renderBlockHtml } from '../../src/md/md-render.js';
import { sniffFlavor } from '../../src/md/md-flavor.js';
import type { Op } from '../../src/engine/ops.js';

describe('adv: editText on a no-DOM (definition) block bypasses dry-run, throws at save', () => {
  it('probe', () => {
    const src = 'para one\n\n[ref]: https://example.com/x\n\npara two\n';
    const doc = parseMarkdownDoc(src);
    console.log('BLOCK IDS >>>', JSON.stringify(doc.blocks.map((b) => ({ id: b.rootId, type: (b.node as { type: string }).type }))));

    // The definition block should be m1 and render to nothing.
    const m1 = doc.blocks.find((b) => b.rootId === 'm1')!;
    console.log('m1 type >>>', (m1.node as { type: string }).type);
    const rendered = renderBlockHtml(m1);
    console.log('renderBlockHtml(m1) >>>', JSON.stringify(rendered));

    // 1) Guard green-lights the editText on m1.
    const guard = guardMdPush('d', { type: 'editText', id: 'm1', html: 'x' }, 'd', doc, [], new Set<string>());
    console.log('GUARD >>>', JSON.stringify(guard));

    // 2) The dry-run WOULD have rejected it.
    const dry = tryApplyMdOps(doc, [{ type: 'editText', id: 'm1', html: 'x' }]);
    console.log('DRY-RUN >>>', JSON.stringify(dry));

    // 3) Save actually throws.
    let threw: string | null = null;
    try {
      const out = serializeMdSource(doc, [{ type: 'editText', id: 'm1', html: 'x' } as Op], sniffFlavor(doc));
      console.log('SAVE OK >>>', JSON.stringify(out));
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    console.log('SAVE THREW >>>', JSON.stringify(threw));

    expect(guard.ok).toBe(true);
    expect(dry.ok).toBe(false);
    expect(threw).not.toBeNull();
  });
});
