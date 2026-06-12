import { REDRA_ID_ATTR } from '../../engine/types.js';
import { HEAVY_STAMPED_ATTR_LIMIT, stubHeavyStampedAttrs } from '../../engine/normalize.js';
import type { EditTextOp } from '../../engine/ops.js';

export type Normalize = (html: string) => string;

/** An active «тыц и пиши» edit session on one element. */
export interface EditSessionState {
  el: HTMLElement;
  id: string;
  /** innerHTML exactly as it was at session start (stamped live DOM). */
  originalHtml: string;
  /** normalize(originalHtml), captured once for the change comparison. */
  originalNormalized: string;
}

export interface CommitResult {
  op: EditTextOp;
  /** For the local inverse stack: stamped innerHTML before / after. */
  prevHtml: string;
  newHtml: string;
}

/**
 * Make `el` contenteditable and capture the pre-session state.
 * Returns null when the element has no redra id (never editable).
 */
export function beginSession(el: HTMLElement, normalize: Normalize): EditSessionState | null {
  const id = el.getAttribute(REDRA_ID_ATTR);
  if (!id) return null;
  const originalHtml = el.innerHTML;
  el.setAttribute('contenteditable', 'true');
  el.classList.add('redra-editing-el');
  return { el, id, originalHtml, originalNormalized: normalize(originalHtml) };
}

/**
 * End the session, keeping the live DOM exactly as the user left it.
 * Returns the op to record, or null when the normalized content did not
 * change (no op, no dirty).
 *
 * The op's html is the WIRE payload: after normalization, heavy attribute
 * values on stamped elements (a replaced image's multi-MB data: URI) are
 * stubbed to "" so the payload never trips main's editText size cap. The
 * live DOM and the local history keep the real values; the saved file gets
 * them back from the journal's own ops via the provenance gate.
 */
export function commitSession(s: EditSessionState, normalize: Normalize): CommitResult | null {
  endVisuals(s.el);
  const newHtml = s.el.innerHTML;
  const normalized = normalize(newHtml);
  if (normalized === s.originalNormalized) return null;
  // A payload at or under the limit cannot contain an over-limit attr —
  // skip the extra parse round-trip for the common small commit.
  const wireHtml =
    normalized.length > HEAVY_STAMPED_ATTR_LIMIT ? stubHeavyStampedAttrs(normalized) : normalized;
  return {
    op: { type: 'editText', id: s.id, html: wireHtml },
    prevHtml: s.originalHtml,
    newHtml,
  };
}

/** End the session restoring the exact pre-session innerHTML (Escape). */
export function revertSession(s: EditSessionState): void {
  endVisuals(s.el);
  s.el.innerHTML = s.originalHtml;
}

function endVisuals(el: HTMLElement): void {
  el.removeAttribute('contenteditable');
  el.classList.remove('redra-editing-el');
  if (el.getAttribute('class') === '') el.removeAttribute('class');
}
