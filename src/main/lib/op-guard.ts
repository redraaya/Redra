import { cloneRootOf, getElementById, getElementId } from '../../engine/index.js';
import { isTemplate, walkElements } from '../../engine/parse.js';
import type { Element, Op, RedraDoc } from '../../engine/index.js';
import type { OpRejectCode } from '../../shared/ipc.js';
import { validateOp } from './validate-op.js';

export type OpCheckResult = { ok: true } | { ok: false; error: string };
export type GuardPushResult =
  | { ok: true; op: Op }
  | { ok: false; error: string; code: OpRejectCode };

/** The cloneIds minted by the ACTIVE journal's cloneBlock ops. */
export function mintedCloneRoots(activeOps: readonly Op[]): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const op of activeOps) if (op.type === 'cloneBlock') roots.add(op.cloneId);
  return roots;
}

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
 * CLONE ids (minted by active cloneBlock ops) have no nodes in the pristine
 * doc to walk, so their subtrees are blocked by the PREFIX RULE instead:
 * every descendant of clone root "c1" is "c1-n" by construction, so
 *  - deleteBlock c1 → "c1" and every "c1-…" id are blocked (complete);
 *  - editText c1   → every "c1-…" id is blocked, "c1" itself stays legal
 *    (complete — the prefix set IS the descendant set for a clone ROOT);
 *  - editText/deleteBlock on a clone DESCENDANT ("c1-4"): only the exact id
 *    can be blocked here — which "c1-n" ids live inside c1-4's subtree is
 *    knowledge only the engine's working tree has, so that residue is
 *    deliberately left to applyOps' removed-set at apply time.
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
  const blockedPrefixes: string[] = [];
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
    const cloneRoot = cloneRootOf(active.id);
    if (cloneRoot !== null) {
      // Clone target: prefix rule (see the contract above).
      if (active.type === 'deleteBlock') blocked.add(active.id);
      if (active.id === cloneRoot) blockedPrefixes.push(`${cloneRoot}-`);
      continue;
    }
    const root = getElementById(doc, active.id);
    if (!root) continue; // journal ops were validated on push; defensive only
    if (active.type === 'deleteBlock') blocked.add(active.id);
    blockDescendants(root);
  }
  if (blocked.size === 0 && blockedPrefixes.length === 0) return { ok: true };

  const targets: string[] = [op.id];
  if (op.type === 'moveBlock' && op.beforeId !== null) targets.push(op.beforeId);

  for (const id of targets) {
    if (blocked.has(id) || blockedPrefixes.some((p) => id.startsWith(p))) {
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
 *  2. cloneBlock never arrives on this channel — its cloneId is minted by
 *     MAIN inside 'ops:cloneBlock' (guardCloneBlock below); a pushed one is
 *     a forgery that could squat a future minted id and wedge saves;
 *  3. shape/id validation against the pristine doc plus the ids minted by
 *     active cloneBlocks (validateOp);
 *  4. blocked-subtree check against the active journal ops.
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
      code: 'stale-doc',
    };
  }
  if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'cloneBlock') {
    return {
      ok: false,
      error: 'cloneBlock arrives via ops:cloneBlock only (main mints the cloneId)',
      code: 'invalid',
    };
  }
  const checked = validateOp(raw, doc, mintedCloneRoots(activeOps));
  if (!checked.ok) return { ok: false, error: checked.error, code: 'invalid' };
  const blocked = checkOpAgainstActive(checked.op, activeOps, doc);
  if (!blocked.ok) return { ok: false, error: blocked.error, code: 'blocked-subtree' };
  return checked;
}

/**
 * The 'ops:cloneBlock' gate: same docId / validation / blocked-subtree
 * sequence as guardDocPush, but for the one op type that channel carries —
 * with the cloneId MAIN just minted (never taken from the wire).
 */
export function guardCloneBlock(
  payloadDocId: unknown,
  targetId: unknown,
  cloneId: string,
  currentDocId: string,
  doc: RedraDoc,
  activeOps: readonly Op[],
): GuardPushResult {
  if (payloadDocId !== currentDocId) {
    return {
      ok: false,
      error: `op for document "${String(payloadDocId)}" rejected: current document is "${currentDocId}"`,
      code: 'stale-doc',
    };
  }
  const raw = { type: 'cloneBlock', id: targetId, cloneId };
  const checked = validateOp(raw, doc, mintedCloneRoots(activeOps));
  if (!checked.ok) return { ok: false, error: checked.error, code: 'invalid' };
  const blocked = checkOpAgainstActive(checked.op, activeOps, doc);
  if (!blocked.ok) return { ok: false, error: blocked.error, code: 'blocked-subtree' };
  return checked;
}
