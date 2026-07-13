/** Barrel for the Markdown engine (pure TS; main-process only). */
export { parseMarkdownDoc, decompositionIsExact, detectEol } from './md-parse.js';
export { renderBlockHtml, renderDocumentBody, escapeHtml, isSafeUrl, collectDefinitions } from './md-render.js';
export type { MdDefinition } from './md-render.js';
export { sanitizeBlockHtml, stripForgedStamps } from './md-sanitize.js';
export { buildDocShell, MD_THEME_PLACEHOLDER } from './doc-shell.js';
export { serializeMdSource, tryApplyMdOps, MdOpError } from './md-ops.js';
export { guardMdPush, validateMdOp } from './md-op-guard.js';
export { sniffFlavor, RICH_DEFAULTS } from './md-flavor.js';
export type { MdFlavor } from './md-flavor.js';
export { writeElementMarkdown } from './md-writer.js';
export { mdRootOf, mdBlockIndexOf, cloneRootOf, anyRootOf } from './md-types.js';
export { toMarkdownV2 } from './telegram/to-markdownv2.js';
export { toTelegramHtml } from './telegram/to-html.js';
export type { MdDoc, MdBlockEntry, MdSpan } from './md-types.js';
