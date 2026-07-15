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

  it('no html flavor is published (the macOS composer never reads it)', () => {
    const { state } = parseMd(SRC, 'x.md');
    expect('html' in telegramFlavors(state)).toBe(false);
  });

  it('RTF flavor: explicit attribute flags a naive parser understands', () => {
    const { state } = parseMd(SRC, 'x.md');
    const { rtf } = telegramFlavors(state);
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
    expect(rtf).toContain('{\\b '); // bold as a FLAG, never a font switch
    expect(rtf).toContain('\\u1055 '); // Cyrillic П as a unicode escape
    expect(rtf).toContain('{\\b\\fs40 '); // the H1
    expect(rtf).not.toContain('Times-Bold'); // the textutil failure mode
  });

  it.skipIf(process.platform !== 'darwin')(
    'RTF round-trips through the system reader with SPACES intact (\\uc0 contract)',
    async () => {
      const { execFile } = await import('node:child_process');
      const { state } = parseMd(SRC, 'x.md');
      const { rtf } = telegramFlavors(state);
      const text = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'textutil',
          ['-convert', 'txt', '-format', 'rtf', '-stdin', '-stdout'],
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
        child.stdin?.end(rtf);
      });
      expect(text).toContain('Жирный и'); // words keep their separating spaces
    },
  );
});
