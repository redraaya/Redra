import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { serializeMdSource } from '../../src/md/md-ops.js';
import { normalizeEditedHtml } from '../../src/engine/normalize.js';
import { RICH_DEFAULTS } from '../../src/md/md-flavor.js';
import type { MdFlavor } from '../../src/md/md-flavor.js';

/**
 * Stage-5 tier-1: the exact HTML the quick toolbar produces in real Chromium
 * (verified by scripts/md-toolbar-probe.cjs) must survive the SAVE path —
 * normalizeEditedHtml('md') then the md writer — to the right markdown. This
 * is the piece jsdom can't exercise (execCommand), pinned as data here.
 */

// What the probe observed each action leaving in the contenteditable:
const PROBE = {
  underline: 'before <u>mid</u> after',
  strike: 'before <strike>mid</strike> after', // execCommand('strikeThrough')
  spoiler: 'before <tg-spoiler>mid</tg-spoiler> after',
  mark: 'before <mark>mid</mark> after',
};

/** Simulate the save path for a paragraph edited to `html`. */
function savedMd(html: string, flavor: MdFlavor = RICH_DEFAULTS): string {
  const payload = normalizeEditedHtml(html, 'md'); // preload commit step
  const doc = parseMarkdownDoc('placeholder\n');
  return serializeMdSource(doc, [{ type: 'editText', id: 'm0', html: payload }], flavor).trim();
}

describe('quick-toolbar tags survive normalize + writer to markdown', () => {
  it('underline → inline <u> (Telegram-Rich underline)', () => {
    // normalize keeps <u>; writer emits it as the underline form.
    expect(normalizeEditedHtml(PROBE.underline, 'md')).toContain('<u>mid</u>');
    expect(savedMd(PROBE.underline)).toBe('before <u>mid</u> after');
  });

  it('deprecated <strike> from execCommand → ~~mid~~ (not dropped!)', () => {
    // The defensive fix: <strike> stays through normalize and writes as strike.
    expect(normalizeEditedHtml(PROBE.strike, 'md')).toContain('strike');
    expect(savedMd(PROBE.strike)).toBe('before ~~mid~~ after');
  });

  it('spoiler <tg-spoiler> → ||mid|| (pipes) or tag, per flavor', () => {
    expect(savedMd(PROBE.spoiler)).toBe('before ||mid|| after');
    const tagFlavor: MdFlavor = { ...RICH_DEFAULTS, spoiler: 'tag' };
    expect(savedMd(PROBE.spoiler, tagFlavor)).toBe('before <tg-spoiler>mid</tg-spoiler> after');
  });

  it('highlight <mark> → ==mid==', () => {
    expect(savedMd(PROBE.mark)).toBe('before ==mid== after');
  });

  it('a file using __underline__... still gets <u> (Telegram uses inline <u>, never __)', () => {
    // Underline has no portable Markdown delimiter — always inline <u>.
    expect(savedMd('<u>x</u>')).toBe('<u>x</u>');
  });
});
