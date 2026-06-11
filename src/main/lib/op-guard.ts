import { getElementById, getElementId } from '../../engine/index.js';
import { isTemplate, walkElements } from '../../engine/parse.js';
import type { Element, Op, RedraDoc } from '../../engine/index.js';
import { validateOp } from './validate-op.js';

export type OpCheckResult = { ok: true } | { ok: false; error: string };
export type GuardPushResult = { ok: true; op: Op } | { ok: false; error: string };

/**
 * Reject at PUSH time the ops that applyOps would reject at SAVE time —
 * ops targeting elements inside subtrees already consumed by an active
 * editText/deleteBlock. Mirrors the engine's `removed` bookkeeping by
 * construction: the blocked set is built by walking DOWN from each root with
 * the engine's own walkElements (template-content aware), exactly like the
 * engine's markSubtreeRemoved does at save time:
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
  const blocked = new Set<string>();
  const blockDescendants = (root: Element): void => {
    const visit = (el: Element): void => {
      const id = getElementId(doc, el);
      if (id !== undefined) blocked.add(id);
    };
    if (isTemplate(root)) walkElements(root.content, visit);
    walkElements(root, visit);
  };
  for (const active of activeOps) {
    if (active.type !== 'editText' && active.type !== 'deleteBlock') continue;
    const root = getElementById(doc, active.id);
    if (!root) continue; // journal ops were validated on push; defensive only
    if (active.type === 'deleteBlock') blocked.add(active.id);
    blockDescendants(root);
  }
  if (blocked.size === 0) return { ok: true };

  const targets: string[] = [op.id];
  if (op.type === 'moveBlock' && op.beforeId !== null) targets.push(op.beforeId);

  for (const id of targets) {
    if (blocked.has(id)) {
      return { ok: false, error: `"${id}" is inside an edited/deleted block` };
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
