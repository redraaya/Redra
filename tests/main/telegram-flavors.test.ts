import { describe, expect, it } from 'vitest';
import { parseMd, telegramFlavors } from '../../src/main/format/md-doc.js';
import { renderDocumentBody } from '../../src/md/index.js';
import { parseMarkdownDoc } from '../../src/md/md-parse.js';

/** The clipboard contract for the 2026 Telegram composer. */
describe('telegramFlavors', () => {
  const SRC = '# Пост\n\n**Жирный** и ==важное==.\n\n- [x] сделано\n';

  it('text flavor IS the clean GFM source — never an escaped dialect', () => {
    const { state } = parseMd(SRC, 'x.md');
    expect(telegramFlavors(state).text).toBe(SRC);
  });

  it('text flavor follows the live body (current edits included)', () => {
    const { state } = parseMd(SRC, 'x.md');
    const body = renderDocumentBody(state.mdDoc.blocks).replace('Жирный', 'Правленый');
    state.liveBody = body;
    expect(telegramFlavors(state).text).toContain('**Правленый**');
  });

  it('html flavor is standard scrubbed markup', () => {
    const { state } = parseMd(SRC, 'x.md');
    const { html } = telegramFlavors(state);
    expect(html).toContain('<h1>Пост</h1>');
    expect(html).toContain('<strong>Жирный</strong>');
    expect(html).toContain('☑');
    expect(html).not.toContain('data-redra');
    expect(html).not.toContain('<input');
  });
});
