/**
 * Main-process glue for a Markdown OpenedDoc. Keeps the md engine (src/md)
 * behind a few functions the DocumentManager and ipc handlers call, so the
 * HTML code paths stay byte-identical — the format branch is a small,
 * reviewable set of call sites, never a change to the engine or the guard.
 */
import {
  parseMarkdownDoc,
  renderDocumentBody,
  buildDocShell,
  serializeMdFromBody,
  sniffFlavor,
  toClipboardHtml,
  toClipboardRtf,
  escapeHtml,
} from '../../md/index.js';
import type { MdDoc, MdFlavor } from '../../md/index.js';
import { MD_THEME } from './md-theme.js';

export interface MdState {
  mdDoc: MdDoc;
  flavor: MdFlavor;
  /**
   * MD 2.0 whole-document editing: the newest committed <main> innerHTML from
   * the live view (null until the first commit). The body-diff serializer runs
   * against it; `mdDoc` stays the OPEN-TIME baseline for the document's whole
   * life (mirrors how the HTML journal accumulates since open).
   */
  liveBody: string | null;
  /** True from the first input event until a save catches up (see gens). */
  liveDirty: boolean;
  /**
   * Renderer input-generation counters guarding two loss races: `dirtyGen` is
   * the newest generation the view REPORTED edits for; `bodyGen` is the
   * generation captured by the newest committed body. A save clears liveDirty
   * only when bodyGen >= dirtyGen (keystrokes typed while the save was in
   * flight keep the doc dirty), and a save must FAIL rather than write stale
   * bytes when a commit could not be captured (dirty but body generation
   * behind).
   */
  dirtyGen: number;
  bodyGen: number;
}

const freshState = (mdDoc: MdDoc): MdState => ({
  mdDoc,
  flavor: sniffFlavor(mdDoc),
  liveBody: null,
  liveDirty: false,
  dirtyGen: 0,
  bodyGen: 0,
});

/** Parse .md text → served HTML shell + the state save/guard need. */
export function parseMd(text: string, title: string): { stampedHtml: string; state: MdState } {
  const mdDoc = parseMarkdownDoc(text);
  const body = renderDocumentBody(mdDoc.blocks);
  const stampedHtml = buildDocShell(title, body, MD_THEME);
  return { stampedHtml, state: freshState(mdDoc) };
}

/**
 * MD 2.0 save text: the body-diff serializer over the newest committed live
 * body; a document whose view never committed anything is the source itself.
 */
export function serializeMdLive(state: MdState): string {
  if (state.liveBody === null) return state.mdDoc.source;
  return serializeMdFromBody(state.mdDoc, state.liveBody, state.flavor);
}

/** The source a new (⌘N) untitled document starts from: a single empty
 *  heading — the caret's home, "just start typing" (matches the mockup). */
export const UNTITLED_MD_SOURCE = '# ';

/**
 * Build the served shell for a NEW untitled Markdown document. Same pipeline
 * as parseMd, but the lone empty heading carries a localized `data-redra-ph`
 * placeholder so the first block is visible and clickable before any typing.
 * The attribute is presentation-only (it never enters the source or the save
 * path — materialize re-renders from the pristine slice), so it cannot corrupt
 * a save.
 */
export function newUntitledMd(
  title: string,
  placeholder: string,
): { stampedHtml: string; state: MdState } {
  const mdDoc = parseMarkdownDoc(UNTITLED_MD_SOURCE);
  const bare = renderDocumentBody(mdDoc.blocks);
  // renderDocumentBody stamps the heading as `<h1 data-redra-id="m0"></h1>`;
  // splice in the placeholder attribute. If the render ever changes shape the
  // replace is a no-op and the doc still works (just without the hint).
  const body = bare.replace(
    '<h1 data-redra-id="m0">',
    `<h1 data-redra-id="m0" data-redra-ph="${escapeHtml(placeholder)}">`,
  );
  const stampedHtml = buildDocShell(title, body, MD_THEME);
  return { stampedHtml, state: freshState(mdDoc) };
}

/**
 * "Copy for Telegram": the document's CURRENT content in the two flavors the
 * 2026 composer actually eats — STANDARD document HTML (our own render,
 * scrubbed of internals: a rich paste lands with headings/lists/checklists/
 * tables live) and, as the text fallback, the clean GFM source itself (never
 * an escaped bot dialect: a text-only paste must read as Markdown).
 */
export function telegramFlavors(state: MdState): { text: string; html: string; rtf: string } {
  const source = serializeMdLive(state);
  const doc = parseMarkdownDoc(source);
  const html = toClipboardHtml(renderDocumentBody(doc.blocks));
  // RTF is hand-written with EXPLICIT \b/\i/\ul flags: field round 3 proved
  // Telegram's composer reads the RTF flavor but ignores textutil's
  // font-switch emphasis (Times-Bold), keeping only links. Naive parsers get
  // flags; capable ones (TextEdit, Pages, Mail) read the same primitives.
  return { text: source, html, rtf: toClipboardRtf(html) };
}
