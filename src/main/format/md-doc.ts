/**
 * Main-process glue for a Markdown OpenedDoc. Keeps the md engine (src/md)
 * behind a few functions the DocumentManager and ipc handlers call, so the
 * HTML code paths stay byte-identical — the format branch is a small,
 * reviewable set of call sites, never a change to the engine or the guard.
 */
import type { Op } from '../../engine/index.js';
import type { OpRejectCode } from '../../shared/ipc.js';
import {
  parseMarkdownDoc,
  renderDocumentBody,
  renderBlockHtml,
  collectDefinitions,
  buildDocShell,
  serializeMdSource,
  serializeMdFromBody,
  guardMdPush,
  sniffFlavor,
  mdRootOf,
  mdBlockIndexOf,
  toMarkdownV2,
  toTelegramHtml,
  escapeHtml,
} from '../../md/index.js';
import type { MdDoc, MdFlavor, MdDefinition } from '../../md/index.js';
import { MD_THEME } from './md-theme.js';

export interface MdState {
  mdDoc: MdDoc;
  flavor: MdFlavor;
  /** Minted clone ids active in this document (for guard validation). */
  mintedClones: Set<string>;
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
  mintedClones: new Set(),
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

/** Save text (the .md source) for a set of journal ops. */
export function serializeMd(state: MdState, ops: readonly Op[]): string {
  return serializeMdSource(state.mdDoc, ops, state.flavor);
}

/**
 * "Copy for Telegram": the document's CURRENT content (the committed live
 * body, serialized and re-parsed) rendered as both clipboard flavors —
 * MarkdownV2 (for the classic composer / Bot API) and Telegram HTML
 * parse-mode (Desktop pastes it rich).
 */
export function telegramFlavors(state: MdState): { markdownV2: string; html: string } {
  const tree = parseMarkdownDoc(serializeMdLive(state)).tree;
  return { markdownV2: toMarkdownV2(tree), html: toTelegramHtml(tree) };
}

export type MdGuardResult =
  | { ok: true; op: Op }
  | { ok: false; error: string; code: OpRejectCode };

/** ops:push gate for md — mirrors guardDocPush's return contract. */
export function guardMd(
  payloadDocId: unknown,
  raw: unknown,
  currentDocId: string,
  state: MdState,
  activeOps: readonly Op[],
): MdGuardResult {
  return guardMdPush(payloadDocId, raw, currentDocId, state.mdDoc, activeOps, state.mintedClones);
}

/**
 * Re-render one block's HTML by id (for a live clone insert). md v1 keeps
 * block duplication simple: the clone is a fresh render of the SAME source
 * block stamped under a minted clone id. Returns null if the id is unknown.
 */
export function renderMdCloneFragment(state: MdState, targetId: string, cloneId: string): string | null {
  const root = mdRootOf(targetId);
  if (root !== targetId) return null; // v1: only top-level blocks clone
  const idx = mdBlockIndexOf(targetId);
  if (idx === null || idx < 0 || idx >= state.mdDoc.blocks.length) return null;
  const block = state.mdDoc.blocks[idx]!;
  const defs = new Map<string, MdDefinition>();
  for (const b of state.mdDoc.blocks) {
    for (const [k, v] of collectDefinitions(b.node as { children?: unknown[] })) defs.set(k, v);
  }
  const html = renderBlockHtml({ ...block, rootId: cloneId }, defs);
  state.mintedClones.add(cloneId);
  return html;
}
