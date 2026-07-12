/**
 * ops:push guard for Markdown documents — the md analog of op-guard.ts.
 *
 * Same shape as guardDocPush: docId match → shape/id validation → blocked-
 * subtree check → dry-run for the hard residue. The blocked-subtree logic is
 * pure PREFIX arithmetic (no tree walk needed): md ids are "m<i>" / "m<i>-<n>"
 * (and minted clones "c<n>" / "c<n>-<k>"), so an active editText on "m3"
 * blocks every "m3-…" descendant while "m3" itself stays legal (re-editText
 * replaces the replacement), and deleteBlock "m3" blocks "m3" and "m3-…".
 * tryApplyMdOps closes anything the cheap rules miss (nested moves/clones).
 */
import type { Op } from '../engine/ops.js';
import type { OpRejectCode } from '../shared/ipc.js';
import { MAX_EDIT_HTML_LENGTH } from '../main/lib/validate-op.js';
import { tryApplyMdOps } from './md-ops.js';
import { mdRootOf } from './md-types.js';
import type { MdDoc } from './md-types.js';

const MD_ID = /^m\d+(-\d+)?$/;
const CLONE_ID = /^c\d+(-\d+)?$/;
const cloneRootOf = (id: string): string | null => {
  const m = /^(c\d+)(?:-\d+)?$/.exec(id);
  return m ? m[1]! : null;
};

export type MdGuardResult =
  | { ok: true; op: Op }
  | { ok: false; error: string; code: OpRejectCode };

const isKnownId = (id: string, mintedClones: ReadonlySet<string>): boolean => {
  if (MD_ID.test(id)) return true;
  const root = cloneRootOf(id);
  return root !== null && mintedClones.has(root) && CLONE_ID.test(id);
};

/** Shape + id validation against the md doc and the ids minted by active clones. */
export function validateMdOp(raw: unknown, doc: MdDoc, mintedClones: ReadonlySet<string>): MdGuardResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'op must be an object', code: 'invalid' };
  }
  const op = raw as Record<string, unknown>;
  if (typeof op.type !== 'string' || typeof op.id !== 'string') {
    return { ok: false, error: 'op missing type/id', code: 'invalid' };
  }
  if (!isKnownId(op.id, mintedClones)) {
    return { ok: false, error: `unknown id: ${op.id}`, code: 'invalid' };
  }
  const rootIndexKnown = (id: string): boolean => {
    const root = mdRootOf(id);
    if (root === null) return CLONE_ID.test(id); // clone ids resolved by dry-run
    const idx = Number(root.slice(1));
    return idx >= 0 && idx < doc.blocks.length;
  };
  switch (op.type) {
    case 'editText':
      if (typeof op.html !== 'string')
        return { ok: false, error: 'editText missing html', code: 'invalid' };
      if (op.html.length > MAX_EDIT_HTML_LENGTH)
        return { ok: false, error: `editText html exceeds ${MAX_EDIT_HTML_LENGTH}`, code: 'invalid' };
      if (!rootIndexKnown(op.id))
        return { ok: false, error: `no such block: ${op.id}`, code: 'invalid' };
      return { ok: true, op: { type: 'editText', id: op.id, html: op.html } };
    case 'deleteBlock':
      if (!rootIndexKnown(op.id))
        return { ok: false, error: `no such block: ${op.id}`, code: 'invalid' };
      return { ok: true, op: { type: 'deleteBlock', id: op.id } };
    case 'moveBlock': {
      const beforeId = op.beforeId;
      if (beforeId !== null && typeof beforeId !== 'string')
        return { ok: false, error: 'moveBlock beforeId must be string|null', code: 'invalid' };
      if (beforeId !== null && !isKnownId(beforeId, mintedClones))
        return { ok: false, error: `unknown beforeId: ${beforeId}`, code: 'invalid' };
      return { ok: true, op: { type: 'moveBlock', id: op.id, beforeId: (beforeId ?? null) as string | null } };
    }
    case 'setAttr':
      // Image replacement is intentionally disabled for md (plan §1.5).
      return { ok: false, error: 'setAttr is not supported for Markdown', code: 'invalid' };
    case 'cloneBlock':
      return { ok: false, error: 'cloneBlock arrives via ops:cloneBlock only', code: 'invalid' };
    default:
      return { ok: false, error: `unknown op type: ${op.type}`, code: 'invalid' };
  }
}

/** Ids consumed by an active editText/deleteBlock, expressed as blocked ids +
 *  blocked prefixes (the descendant set of each edited/deleted root). */
function blockedSets(activeOps: readonly Op[]): { blocked: Set<string>; prefixes: string[] } {
  const blocked = new Set<string>();
  const prefixes: string[] = [];
  for (const op of activeOps) {
    if (op.type === 'editText') {
      prefixes.push(`${op.id}-`); // children replaced; root stays legal
    } else if (op.type === 'deleteBlock') {
      blocked.add(op.id);
      prefixes.push(`${op.id}-`);
    } else if (op.type === 'cloneBlock') {
      // A clone's descendants are "cloneId-…"; the root stays editable.
      // (Nothing to block for a fresh clone target.)
    }
  }
  return { blocked, prefixes };
}

function isBlocked(id: string, sets: { blocked: Set<string>; prefixes: string[] }): boolean {
  if (sets.blocked.has(id)) return true;
  return sets.prefixes.some((p) => id.startsWith(p));
}

/** The full push gate (pure, testable). `dryRun` injectable for tests. */
export function guardMdPush(
  payloadDocId: unknown,
  raw: unknown,
  currentDocId: string,
  doc: MdDoc,
  activeOps: readonly Op[],
  mintedClones: ReadonlySet<string>,
  dryRun: typeof tryApplyMdOps = tryApplyMdOps,
): MdGuardResult {
  if (payloadDocId !== currentDocId) {
    return {
      ok: false,
      error: `op for document "${String(payloadDocId)}" rejected: current is "${currentDocId}"`,
      code: 'stale-doc',
    };
  }
  const checked = validateMdOp(raw, doc, mintedClones);
  if (!checked.ok) return checked;

  const sets = blockedSets(activeOps);
  const targets: string[] = [checked.op.id];
  if (checked.op.type === 'moveBlock' && checked.op.beforeId !== null) targets.push(checked.op.beforeId);
  for (const id of targets) {
    if (isBlocked(id, sets)) {
      return { ok: false, error: `"${id}" is inside an edited/deleted block`, code: 'blocked-subtree' };
    }
  }
  // Nested/clone-referencing ops: the cheap prefix rule can't express
  // "descendant of m3-2", so confirm the whole sequence applies.
  const referencesNested = /-\d+$/.test(checked.op.id) || cloneRootOf(checked.op.id) !== null;
  if (referencesNested) {
    const applied = dryRun(doc, [...activeOps, checked.op]);
    if (!applied.ok) return { ok: false, error: applied.error, code: 'blocked-subtree' };
  }
  return checked;
}
