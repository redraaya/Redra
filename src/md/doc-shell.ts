/**
 * Full-document HTML shell for a rendered .md file. The theme CSS is
 * embedded in <head> — no CSP games, no FOUC, and printToPDF picks it up
 * with zero extra work (unlike the @media-screen editor chrome).
 * Real theme values land in Stage 4 from the approved mockup; until then
 * MD_THEME_PLACEHOLDER keeps documents readable.
 */
import { escapeHtml } from './md-render.js';

export const MD_THEME_PLACEHOLDER = `
  body { margin: 0; background: #fbfaf7; color: #26241f;
    font: 17px/1.72 "Iowan Old Style", Palatino, Georgia, serif; }
  main { max-width: 680px; margin: 0 auto; padding: 52px 24px 64px; }
  @media (prefers-color-scheme: dark) {
    body { background: #191816; color: #e7e5df; }
  }
`;

export function buildDocShell(title: string, bodyHtml: string, themeCss: string): string {
  return (
    '<!doctype html>\n<html data-redra-format="md">\n<head>\n<meta charset="utf-8">\n' +
    `<title>${escapeHtml(title)}</title>\n<style>${themeCss}</style>\n</head>\n` +
    `<body><main>\n${bodyHtml}\n</main></body>\n</html>\n`
  );
}
