import { getElementById } from '../../engine/index.js';
import type { Op, RedraDoc } from '../../engine/index.js';

/** Upper bound for an editText payload — anything bigger is a bug or abuse. */
export const MAX_EDIT_HTML_LENGTH = 2 * 1024 * 1024;

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
  if (type !== 'editText' && type !== 'deleteBlock' && type !== 'moveBlock') {
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
  }
}
