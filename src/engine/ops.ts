import { parseFragment } from 'parse5';
import { isTemplate, walkElements } from './parse.js';
import { REDRA_ID_ATTR, type Element, type ParentNode, type RedraDoc } from './types.js';

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
    super(`${op.type}: ${reason}`);
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

  // Mark every descendant of `el` as removed. For a <template> the children
  // live in el.content, which walkElements only descends into for CHILD
  // templates — the root's content must be walked explicitly.
  const markSubtreeRemoved = (el: Element): void => {
    if (isTemplate(el)) walkElements(el.content, (d) => removed.add(d));
    walkElements(el, (d) => removed.add(d));
  };

  // The save output must never contain data-redra-id: Stage 3 captures
  // editText html from the STAMPED live DOM, so fragments may carry stamps.
  const stripRedraIds = (root: ParentNode): void => {
    walkElements(root, (el) => {
      el.attrs = el.attrs.filter((a) => a.name !== REDRA_ID_ATTR);
    });
  };

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
        markSubtreeRemoved(el); // old children are gone
        const fragment = parseFragment(el, op.html, {});
        stripRedraIds(fragment);
        // For a <template> the children live in el.content, and the
        // serializer reads them from there.
        const container: ParentNode = isTemplate(el) ? el.content : el;
        container.childNodes = [];
        for (const child of fragment.childNodes) {
          child.parentNode = container;
          container.childNodes.push(child);
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
        markSubtreeRemoved(el);
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
