/** Barrel for the Markdown engine (pure TS; main-process only). */
export { parseMarkdownDoc, decompositionIsExact, detectEol } from './md-parse.js';
export { renderBlockHtml, renderDocumentBody, escapeHtml, isSafeUrl } from './md-render.js';
export { sanitizeBlockHtml, stripForgedStamps } from './md-sanitize.js';
export { buildDocShell, MD_THEME_PLACEHOLDER } from './doc-shell.js';
export { mdRootOf, mdBlockIndexOf } from './md-types.js';
export type { MdDoc, MdBlockEntry, MdSpan } from './md-types.js';
