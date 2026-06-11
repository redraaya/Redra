import { getElementById, getElementId } from '../../engine/index.js';
import type { Element, Op, RedraDoc } from '../../engine/index.js';
import { validateOp } from './validate-op.js';

export type OpCheckResult = { ok: true } | { ok: false; error: string };
export type GuardPushResult = { ok: true; op: Op } | { ok: false; error: string };

/**
 * Reject at PUSH time the ops that applyOps would reject at SAVE time —
 * ops targeting elements inside subtrees already consumed by an active
 * editText/deleteBlock. Mirrors the engine's `removed` bookkeeping exactly:
 *
 *  - editText X replaces X's CHILDREN → descendants of X are blocked, but X
 *    itself stays legal (re-editText replaces the replacement; deleteBlock /
 *    moveBlock on X also still work);
 *  - deleteBlock X detaches X and its subtree → X AND its descendants are
 *    blocked (double delete included);
 *  - moveBlock's beforeId is resolved by the engine too, so it gets the
 *    same checks as the target id.
 *
 * `activeOps` must be the journal's ACTIVE ops (journal.ops) — after an undo
 * the caller passes the shrunken list and the block lifts automatically.
 */
export function checkOpAgainstActive(
  op: Op,
  activeOps: readonly Op[],
  doc: RedraDoc,
): OpCheckResult {
  const editedRoots = new Set<string>();
  const deletedRoots = new Set<string>();
  for (const active of activeOps) {
    if (active.type === 'editText') editedRoots.add(active.id);
    else if (active.type === 'deleteBlock') deletedRoots.add(active.id);
  }
  if (editedRoots.size === 0 && deletedRoots.size === 0) return { ok: true };

  const targets: string[] = [op.id];
  if (op.type === 'moveBlock' && op.beforeId !== null) targets.push(op.beforeId);

  for (const id of targets) {
    if (deletedRoots.has(id)) {
      return { ok: false, error: `"${id}" is inside an edited/deleted block ("${id}" was deleted)` };
    }
    const el = getElementById(doc, id);
    if (!el) return { ok: false, error: `unknown element id "${id}"` }; // validateOp catches this first
    // Walk UP the pristine ancestors: hitting any edited/deleted root means
    // this element's subtree was already replaced or detached.
    let node: unknown = el.parentNode;
    while (node) {
      const ancestorId = getElementId(doc, node as Element);
      if (ancestorId !== undefined && (editedRoots.has(ancestorId) || deletedRoots.has(ancestorId))) {
        return {
          ok: false,
          error: `"${id}" is inside an edited/deleted block (ancestor "${ancestorId}")`,
        };
      }
      node = (node as { parentNode?: unknown }).parentNode ?? null;
    }
  }
  return { ok: true };
}

/**
 * The full ops:push gate, pure and testable:
 *  1. docId match — the doc view WebContents is REUSED across documents, so
 *     an in-flight invoke from the previous document must not land in the
 *     new document's journal (stamp ids like "r5" exist in every doc);
 *  2. shape/id validation against the pristine doc (validateOp);
 *  3. blocked-subtree check against the active journal ops.
 */
export function guardDocPush(
  payloadDocId: unknown,
  raw: unknown,
  currentDocId: string,
  doc: RedraDoc,
  activeOps: readonly Op[],
): GuardPushResult {
  if (payloadDocId !== currentDocId) {
    return {
      ok: false,
      error: `op for document "${String(payloadDocId)}" rejected: current document is "${currentDocId}"`,
    };
  }
  const checked = validateOp(raw, doc);
  if (!checked.ok) return checked;
  const blocked = checkOpAgainstActive(checked.op, activeOps, doc);
  if (!blocked.ok) return blocked;
  return checked;
}
