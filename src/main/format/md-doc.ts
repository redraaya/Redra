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
  buildDocShell,
  serializeMdSource,
  guardMdPush,
  sniffFlavor,
  mdRootOf,
  mdBlockIndexOf,
} from '../../md/index.js';
import type { MdDoc, MdFlavor } from '../../md/index.js';
import { MD_THEME } from './md-theme.js';

export interface MdState {
  mdDoc: MdDoc;
  flavor: MdFlavor;
  /** Minted clone ids active in this document (for guard validation). */
  mintedClones: Set<string>;
}

/** Parse .md text → served HTML shell + the state save/guard need. */
export function parseMd(text: string, title: string): { stampedHtml: string; state: MdState } {
  const mdDoc = parseMarkdownDoc(text);
  const body = renderDocumentBody(mdDoc.blocks);
  const stampedHtml = buildDocShell(title, body, MD_THEME);
  return { stampedHtml, state: { mdDoc, flavor: sniffFlavor(mdDoc), mintedClones: new Set() } };
}

/** Save text (the .md source) for a set of journal ops. */
export function serializeMd(state: MdState, ops: readonly Op[]): string {
  return serializeMdSource(state.mdDoc, ops, state.flavor);
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
  const html = renderBlockHtml({ ...block, rootId: cloneId });
  state.mintedClones.add(cloneId);
  return html;
}
