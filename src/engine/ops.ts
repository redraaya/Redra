import { parseFragment } from 'parse5';
import { walkElements } from './parse.js';
import type { Element, RedraDoc } from './types.js';

/** Replace ALL children of element `id` with the given HTML fragment. */
export type EditTextOp = { type: 'editText'; id: string; html: string };
/** Detach element `id` (and its whole subtree) from its parent. */
export type DeleteBlockOp = { type: 'deleteBlock'; id: string };
/**
 * Reorder element `id` WITHIN ITS CURRENT PARENT: insert before sibling
 * `beforeId`, or append to the end of the parent when `beforeId` is null.
 */
export type MoveBlockOp = { type: 'moveBlock'; id: string; beforeId: string | null };

/** A recorded edit. Plain JSON data — safe to send over IPC and persist. */
export type Op = EditTextOp | DeleteBlockOp | MoveBlockOp;

/** Thrown when an operation cannot be applied to the document. */
export class RedraOpError extends Error {
  readonly op: Op;
  readonly reason: string;

  constructor(op: Op, reason: string) {
    super(`${op.type} "${op.id}": ${reason}`);
    this.name = 'RedraOpError';
    this.op = op;
    this.reason = reason;
  }
}

/**
 * Apply operations IN ORDER, mutating the document's tree.
 *
 * Intended for clones only (see serializeSource) — the pristine doc of an
 * open file must never be passed here.
 *
 * @internal
 */
export function applyOps(doc: RedraDoc, ops: readonly Op[]): void {
  // Elements removed from the tree by an earlier op (deleteBlock target and
  // its subtree, old children replaced by editText). Targeting them is an
  // error: their ids no longer correspond to anything in the output.
  const removed = new Set<Element>();

  const resolve = (op: Op, id: string, role: string): Element => {
    const el = doc.idToNode.get(id);
    if (!el) {
      throw new RedraOpError(op, `${role} "${id}" does not exist in the document`);
    }
    if (removed.has(el)) {
      throw new RedraOpError(op, `${role} "${id}" was removed by an earlier operation`);
    }
    return el;
  };

  for (const op of ops) {
    switch (op.type) {
      case 'editText': {
        const el = resolve(op, op.id, 'element');
        walkElements(el, (d) => removed.add(d)); // old children are gone
        const fragment = parseFragment(el, op.html, {});
        el.childNodes = [];
        for (const child of fragment.childNodes) {
          child.parentNode = el;
          el.childNodes.push(child);
        }
        break;
      }
      case 'deleteBlock': {
        const el = resolve(op, op.id, 'element');
        const parent = el.parentNode;
        if (!parent) {
          throw new RedraOpError(op, `element "${op.id}" has no parent to detach from`);
        }
        parent.childNodes.splice(parent.childNodes.indexOf(el), 1);
        el.parentNode = null;
        removed.add(el);
        walkElements(el, (d) => removed.add(d));
        break;
      }
      case 'moveBlock': {
        if (op.beforeId === op.id) {
          throw new RedraOpError(op, 'beforeId must not equal id');
        }
        const el = resolve(op, op.id, 'element');
        const parent = el.parentNode;
        if (!parent) {
          throw new RedraOpError(op, `element "${op.id}" has no parent to move within`);
        }
        // Only the element moves; surrounding text nodes stay where they are.
        parent.childNodes.splice(parent.childNodes.indexOf(el), 1);
        if (op.beforeId === null) {
          parent.childNodes.push(el);
        } else {
          const before = resolve(op, op.beforeId, 'beforeId element');
          if (before.parentNode !== parent) {
            throw new RedraOpError(
              op,
              `beforeId "${op.beforeId}" is not a sibling of "${op.id}" (different parent)`,
            );
          }
          parent.childNodes.splice(parent.childNodes.indexOf(before), 0, el);
        }
        break;
      }
    }
  }
}
