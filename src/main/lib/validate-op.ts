import { cloneRootOf, getElementById, SETATTR_ALLOWED_NAMES } from '../../engine/index.js';
import type { Op, RedraDoc } from '../../engine/index.js';

/** Upper bound for an editText payload — anything bigger is a bug or abuse. */
export const MAX_EDIT_HTML_LENGTH = 2 * 1024 * 1024;

/**
 * Upper bound for a setAttr value. The user-facing cap is a 10 MB image
 * FILE (enforced in main before the data: URI is built); base64 inflates
 * those bytes by 4/3, so the wire-level cap is 14 MB — a 10 MB image fits,
 * anything meaningfully bigger is a bug or abuse.
 */
export const MAX_SETATTR_VALUE_LENGTH = 14 * 1024 * 1024;

/**
 * True when a setAttr src value is allowed through: an inline image
 * (`data:image/...`) or a relative path. Scheme parsing mirrors isSafeHref
 * in the engine (tab/newline/CR stripped everywhere, leading C0/controls
 * stripped, case-insensitive match) so `java\nscript:` cannot smuggle
 * through. Absolute (`/x`), protocol-relative (`//host`), UNC (`\\srv`) and
 * every explicit scheme (javascript:, file:, http:, …) are rejected: v1
 * always embeds base64, relative paths are kept for hand-written journals.
 */
function isSafeImageSrc(value: string): boolean {
  const cleaned = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  if (/^data:image\//i.test(cleaned)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return false; // any other scheme, data:text included
  if (cleaned.startsWith('/') || cleaned.startsWith('\\')) return false;
  return true;
}

export type ValidateOpResult = { ok: true; op: Op } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const NO_MINTED: ReadonlySet<string> = new Set();

/**
 * True when `id` is a clone id derivable from the active journal's
 * cloneBlock ops: the minted root itself ("c1") or a descendant by the
 * PREFIX RULE ("c1-7"). Main cannot know which descendant numbers actually
 * exist (the clone's structure lives in the engine's working tree at apply
 * time) — that half of the validation deliberately stays with applyOps,
 * which resolves every id against the real id map when the journal is
 * replayed. This division is by design: the guard rejects everything not
 * even derivable, the engine rejects the rest at apply.
 */
function isMintedTarget(id: string, mintedRoots: ReadonlySet<string>): boolean {
  const root = cloneRootOf(id);
  return root !== null && mintedRoots.has(root);
}

/**
 * Validate an op arriving over IPC before it reaches the journal.
 *
 * Untrusted input: shape-checked field by field, ids resolved against the
 * pristine document, and the result is a FRESH object (never the incoming
 * one), so extra properties from the wire cannot ride along into the
 * journal / save pipeline.
 *
 * `mintedRoots` are the cloneIds of the ACTIVE journal's cloneBlock ops:
 * ids minted by earlier clones (and their `-n` descendants, accepted by the
 * prefix rule — see isMintedTarget) are legal targets even though they do
 * not exist in the pristine document. Element-shape checks that need the
 * actual node (moveBlock's sibling check, setAttr's <img> check) are
 * SKIPPED for minted ids and enforced by the engine at apply time.
 */
export function validateOp(
  raw: unknown,
  doc: RedraDoc,
  mintedRoots: ReadonlySet<string> = NO_MINTED,
): ValidateOpResult {
  if (!isRecord(raw)) return { ok: false, error: 'op is not an object' };

  const { type, id } = raw;
  if (
    type !== 'editText' &&
    type !== 'deleteBlock' &&
    type !== 'moveBlock' &&
    type !== 'setAttr' &&
    type !== 'cloneBlock'
  ) {
    return { ok: false, error: `unknown op type: ${String(type)}` };
  }
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'op id is not a non-empty string' };
  }
  // `el` stays undefined for minted clone targets — see the contract above.
  const el = getElementById(doc, id);
  if (!el && !isMintedTarget(id, mintedRoots)) {
    return { ok: false, error: `unknown element id "${id}"` };
  }

  switch (type) {
    case 'editText': {
      const html = raw['html'];
      if (typeof html !== 'string') {
        return { ok: false, error: 'editText html is not a string' };
      }
      if (html.length > MAX_EDIT_HTML_LENGTH) {
        return { ok: false, error: `editText html exceeds ${MAX_EDIT_HTML_LENGTH} chars` };
      }
      return { ok: true, op: { type, id, html } };
    }
    case 'deleteBlock':
      return { ok: true, op: { type, id } };
    case 'moveBlock': {
      const beforeId = raw['beforeId'];
      if (beforeId !== null && typeof beforeId !== 'string') {
        return { ok: false, error: 'moveBlock beforeId is not a string or null' };
      }
      if (beforeId !== null) {
        if (beforeId === id) return { ok: false, error: 'moveBlock beforeId equals id' };
        const before = getElementById(doc, beforeId);
        if (!before && !isMintedTarget(beforeId, mintedRoots)) {
          return { ok: false, error: `unknown beforeId "${beforeId}"` };
        }
        // Sibling check needs both real nodes; with a minted id on either
        // side the engine enforces it at apply time instead.
        if (el && before && before.parentNode !== el.parentNode) {
          return { ok: false, error: `beforeId "${beforeId}" is not a sibling of "${id}"` };
        }
      }
      return { ok: true, op: { type, id, beforeId } };
    }
    case 'setAttr': {
      // Defense in depth: setAttr exists only for image replacement. Without
      // the tag check a compromised preload could plant an executable src
      // (data:image/svg+xml with onload, …) on an existing <iframe>/<embed>
      // and the saved file would carry it. parse5 tagNames are lowercase.
      // Minted clone targets cannot be tag-checked here (no node in the
      // pristine map) — the value whitelist below still applies in full.
      if (el && el.tagName !== 'img') {
        return { ok: false, error: 'setAttr target must be <img>' };
      }
      const name = raw['name'];
      if (typeof name !== 'string' || !SETATTR_ALLOWED_NAMES.has(name)) {
        return { ok: false, error: `setAttr name "${String(name)}" is not allowed` };
      }
      const value = raw['value'];
      if (typeof value !== 'string') {
        return { ok: false, error: 'setAttr value is not a string' };
      }
      if (value.length > MAX_SETATTR_VALUE_LENGTH) {
        return { ok: false, error: `setAttr value exceeds ${MAX_SETATTR_VALUE_LENGTH} chars` };
      }
      if (!isSafeImageSrc(value)) {
        return { ok: false, error: 'setAttr value must be a data:image/ URI or a relative path' };
      }
      return { ok: true, op: { type, id, name, value } };
    }
    case 'cloneBlock': {
      // Reaches here only via guardCloneBlock ('ops:cloneBlock' channel,
      // where MAIN minted the cloneId) — guardDocPush rejects the type on
      // the plain ops:push channel before validateOp ever sees it.
      const cloneId = raw['cloneId'];
      if (typeof cloneId !== 'string' || cloneRootOf(cloneId) !== cloneId) {
        return { ok: false, error: `cloneBlock cloneId "${String(cloneId)}" is not "c<number>"` };
      }
      if (mintedRoots.has(cloneId)) {
        return { ok: false, error: `cloneId "${cloneId}" is already used by an active clone` };
      }
      return { ok: true, op: { type, id, cloneId } };
    }
  }
}
