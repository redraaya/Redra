/**
 * Document-format helpers shared by main and the renderer. Types + pure
 * functions only — no Electron, no engine imports.
 */
export type DocFormat = 'html' | 'md';

/** Block types the Markdown "Turn into …" panel offers (Stage 6). */
export type BlockKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'ul'
  | 'ol'
  | 'task'
  | 'blockquote'
  | 'pre'
  | 'hr';

/** Extensions Redra opens, per format. */
export const HTML_EXTENSIONS = ['html', 'htm'] as const;
export const MD_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd'] as const;

const HTML_RE = /\.html?$/i;
const MD_RE = /\.(md|markdown|mdown|mkd)$/i;

/** Any file Redra can open (either format). */
export const OPENABLE_RE = /\.(html?|md|markdown|mdown|mkd)$/i;

export function formatForPath(filePath: string): DocFormat | null {
  if (MD_RE.test(filePath)) return 'md';
  if (HTML_RE.test(filePath)) return 'html';
  return null;
}

/** Strip a known document extension for a default export/name. */
export function stripDocExtension(filePath: string): string {
  return filePath.replace(OPENABLE_RE, '');
}
