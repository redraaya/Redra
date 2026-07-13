import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';
import { serializeMdFromBody } from '../../src/md/md-body-diff.js';
import { RICH_DEFAULTS } from '../../src/md/md-flavor.js';
import type { MdFlavor } from '../../src/md/md-flavor.js';

/**
 * The exact HTML real-Chromium editing produces (verified by
 * scripts/md-toolbar-probe.cjs and the whole-document editing probes) must
 * survive the MD 2.0 SAVE path — the body-diff serializer + md writer — to
 * the right markdown. This is the piece jsdom can't exercise (execCommand),
 * pinned as data here.
 */

// What the probes observed each action leaving in the contenteditable:
const PROBE = {
  underline: 'before <u>mid</u> after',
  strike: 'before <strike>mid</strike> after', // execCommand('strikeThrough')
  spoiler: 'before <tg-spoiler>mid</tg-spoiler> after',
  mark: 'before <mark>mid</mark> after',
  bold: 'before <b>mid</b> after', // execCommand('bold') emits <b>
  chromiumDiv: '<div>a split line with <strong>bold</strong></div>', // stray editing div
};

/** Simulate the 2.0 save path: the whole live body replaces the paragraph. */
function savedMd(inner: string, flavor: MdFlavor = RICH_DEFAULTS): string {
  const doc = parseMarkdownDoc('placeholder\n');
  return serializeMdFromBody(doc, `<p data-redra-id="m0">${inner}</p>`, flavor).trim();
}

describe('real-Chromium editing tags survive the body-diff save to markdown', () => {
  it('underline → inline <u> (Telegram-Rich underline)', () => {
    expect(savedMd(PROBE.underline)).toBe('before <u>mid</u> after');
  });

  it('deprecated <strike> from execCommand → ~~mid~~ (not dropped!)', () => {
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

  it('execCommand bold <b> → **mid**', () => {
    expect(savedMd(PROBE.bold)).toBe('before **mid** after');
  });

  it('a file using __underline__... still gets <u> (Telegram uses inline <u>, never __)', () => {
    expect(savedMd('<u>x</u>')).toBe('<u>x</u>');
  });

  it('a stray Chromium <div> at the top level writes as a paragraph, formatting intact', () => {
    const doc = parseMarkdownDoc('placeholder\n');
    const out = serializeMdFromBody(doc, PROBE.chromiumDiv, RICH_DEFAULTS).trim();
    expect(out).toBe('a split line with **bold**');
  });
});
