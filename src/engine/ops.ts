import { parseFragment, serialize } from 'parse5';
import { DROPPED_TAGS, isSafeHref, KEPT_TAGS } from './normalize.js';
import { isTemplate, walkElements } from './parse.js';
import { REDRA_ID_ATTR, type Element, type ParentNode, type RedraDoc } from './types.js';

type ChildNode = ParentNode['childNodes'][number];

function isElementNode(node: ChildNode): node is Element {
  return 'tagName' in node;
}

/** Tags whose content must be byte-identical to the original to survive. */
const VERBATIM_TAGS = new Set(['script', 'style', 'template']);

/** Concatenated #text content of an element's direct children. */
function textContentOf(el: Element): string {
  let out = '';
  for (const child of el.childNodes) {
    if (child.nodeName === '#text') out += (child as { value: string }).value;
  }
  return out;
}

/** Strip data-redra-id from every element under `root` (template content included). */
function stripStamps(root: ParentNode): void {
  walkElements(root, (el) => {
    el.attrs = el.attrs.filter((a) => a.name !== REDRA_ID_ATTR);
  });
}

/**
 * True when a verbatim-tag element from the fragment carries content
 * byte-identical to the original node's. For script/style that is the raw
 * text; for <template> the serialized content fragment — after stripping
 * stamps from the fragment side, because the live DOM serves STAMPED
 * template content and those stamps are ours, not the file's.
 */
function verbatimContentEquals(el: Element, original: Element): boolean {
  if (isTemplate(el) && isTemplate(original)) {
    stripStamps(el.content);
    return serialize(el.content) === serialize(original.content);
  }
  return textContentOf(el) === textContentOf(original);
}

/**
 * The provenance gate for editText fragments (Stage 3 captures them from
 * the STAMPED live DOM, which page scripts can tamper with — a stamp is a
 * CLAIM, not proof). Mutates the fragment in place:
 *
 * - a stamped element whose id resolves in `idToNode` to an element of the
 *   SAME tag is verified: its live attributes (page-runtime mutations and
 *   all) are REPLACED with the original node's attributes — file content by
 *   definition, javascript: hrefs and on* handlers of the user's own markup
 *   included — and the stamp goes away with the rest of the live attrs;
 * - verified script/style/template must ALSO carry content byte-identical
 *   to the original (verbatim tags execute/define, they are not editable
 *   text) — otherwise the element is removed entirely;
 * - a stamp that does not verify (unknown id, or tag mismatch — forgery or
 *   stale duplication) is DOWNGRADED to the NEW-content rules: provenance-
 *   required tags (DROPPED_TAGS: script/style/template/iframe/object/embed/
 *   link/meta) are removed with their content; inline whitelist tags
 *   (KEPT_TAGS) are kept bare — every attribute is dropped (on* handlers
 *   and custom on-* data attributes alike; no pattern-matching tradeoffs
 *   here, NOTHING survives) except a safe href on <a>; any other tag is
 *   unwrapped, its children re-entering this same gate;
 * - unstamped elements pass through untouched (normalizeEditedHtml already
 *   applied the NEW-content whitelist), but their subtrees — template
 *   content included — are still walked for stamped descendants.
 *
 * Pure tree transform: no I/O, no state beyond the fragment and the map.
 *
 * @internal exported for direct unit tests
 */
export function enforceStampProvenance(
  fragment: ParentNode,
  idToNode: ReadonlyMap<string, Element>,
): void {
  setChildren(fragment, gateSiblings(fragment.childNodes, idToNode));
}

function setChildren(parent: ParentNode, children: ChildNode[]): void {
  parent.childNodes = children;
  for (const child of children) child.parentNode = parent;
}

/** Gate the element's children (template content lives in el.content). */
function gateChildrenOf(el: Element, idToNode: ReadonlyMap<string, Element>): void {
  const container: ParentNode = isTemplate(el) ? el.content : el;
  setChildren(container, gateSiblings(container.childNodes, idToNode));
}

function gateSiblings(
  nodes: readonly ChildNode[],
  idToNode: ReadonlyMap<string, Element>,
): ChildNode[] {
  const out: ChildNode[] = [];
  for (const node of nodes) {
    if (!isElementNode(node)) {
      out.push(node);
      continue;
    }
    const stamp = node.attrs.find((a) => a.name === REDRA_ID_ATTR);
    if (!stamp) {
      gateChildrenOf(node, idToNode);
      out.push(node);
      continue;
    }
    const original = idToNode.get(stamp.value);
    if (original && original.tagName === node.tagName) {
      // Verified: original attributes replace the live ones wholesale.
      node.attrs = original.attrs.map((a) => ({ ...a }));
      if (VERBATIM_TAGS.has(node.tagName)) {
        if (!verbatimContentEquals(node, original)) continue; // tampered — gone
      } else {
        gateChildrenOf(node, idToNode);
      }
      out.push(node);
      continue;
    }
    // Forged / unresolvable stamp: downgrade to NEW-content rules.
    if (DROPPED_TAGS.has(node.tagName)) continue;
    if (KEPT_TAGS.has(node.tagName)) {
      node.attrs =
        node.tagName === 'a'
          ? node.attrs.filter((a) => a.name === 'href' && isSafeHref(a.value))
          : [];
      gateChildrenOf(node, idToNode);
      out.push(node);
    } else {
      out.push(...gateSiblings(node.childNodes, idToNode));
    }
  }
  return out;
}

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
        // Stage 3 captures editText html from the STAMPED live DOM: verify
        // every stamp against the pristine source (see the gate's docs).
        // Side effect: no data-redra-id ever reaches the save output.
        enforceStampProvenance(fragment, doc.idToNode);
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
