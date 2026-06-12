import { getElementById, SETATTR_ALLOWED_NAMES } from '../../engine/index.js';
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

/**
 * Validate an op arriving over IPC before it reaches the journal.
 *
 * Untrusted input: shape-checked field by field, ids resolved against the
 * pristine document, and the result is a FRESH object (never the incoming
 * one), so extra properties from the wire cannot ride along into the
 * journal / save pipeline.
 */
export function validateOp(raw: unknown, doc: RedraDoc): ValidateOpResult {
  if (!isRecord(raw)) return { ok: false, error: 'op is not an object' };

  const { type, id } = raw;
  if (
    type !== 'editText' &&
    type !== 'deleteBlock' &&
    type !== 'moveBlock' &&
    type !== 'setAttr'
  ) {
    return { ok: false, error: `unknown op type: ${String(type)}` };
  }
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'op id is not a non-empty string' };
  }
  const el = getElementById(doc, id);
  if (!el) return { ok: false, error: `unknown element id "${id}"` };

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
        if (!before) return { ok: false, error: `unknown beforeId "${beforeId}"` };
        if (before.parentNode !== el.parentNode) {
          return { ok: false, error: `beforeId "${beforeId}" is not a sibling of "${id}"` };
        }
      }
      return { ok: true, op: { type, id, beforeId } };
    }
    case 'setAttr': {
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
  }
}
