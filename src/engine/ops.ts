import { defaultTreeAdapter, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { DROPPED_TAGS, isSafeHref, KEPT_TAGS } from './normalize.js';
import { isTemplate, parseDocument, walkElements } from './parse.js';
import { REDRA_ID_ATTR, type Element, type ParentNode, type RedraDoc, type Template } from './types.js';

type ChildNode = ParentNode['childNodes'][number];
type TextNode = DefaultTreeAdapterMap['textNode'];
type CommentNode = DefaultTreeAdapterMap['commentNode'];

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
/**
 * Set/replace ONE attribute on element `id` (appended when absent).
 * v1: image replacement — the only allowed name is 'src' (see
 * SETATTR_ALLOWED_NAMES); applyOps rejects everything else, so the journal
 * can never smuggle surprise attributes (onerror, style, …) into the file.
 */
export type SetAttrOp = { type: 'setAttr'; id: string; name: string; value: string };
/**
 * Deep-clone element `id` (attrs, children, template content) and insert the
 * clone immediately AFTER the original among its siblings. `cloneId` is
 * minted by MAIN (format "c<number>", unique per document); the clone's root
 * gets `cloneId` and every descendant element gets `${cloneId}-${n}` in
 * walkElements order — registered in the working tree's id maps so
 * SUBSEQUENT ops (editText/deleteBlock/moveBlock/setAttr and the provenance
 * gate's stamp lookups) resolve cloned elements like any others. The ids
 * never appear as attributes in serialized output.
 */
export type CloneBlockOp = { type: 'cloneBlock'; id: string; cloneId: string };

/** A recorded edit. Plain JSON data — safe to send over IPC and persist. */
export type Op = EditTextOp | DeleteBlockOp | MoveBlockOp | SetAttrOp | CloneBlockOp;

/** The only cloneId shape applyOps accepts — disjoint from parseDocument's "rN". */
const CLONE_ID_RE = /^c\d+$/;

/**
 * "c7" → "c7", "c7-12" → "c7", anything else → null. The single definition
 * of what a minted clone id looks like — main's op-guard derives its
 * "accept by prefix" rule from this, the engine validates roots with it.
 */
export function cloneRootOf(id: string): string | null {
  const m = /^(c\d+)(?:-\d+)?$/.exec(id);
  return m ? m[1]! : null;
}

/**
 * Deep manual clone of a parse5 subtree: attributes, children and template
 * content. Built with defaultTreeAdapter so node shapes match the parser's
 * exactly; parentNode links are wired by appendChild, sourceCodeLocation is
 * deliberately absent (the clone has no source).
 */
function cloneSubtree(node: ChildNode): ChildNode {
  if (isElementNode(node)) {
    const copy = defaultTreeAdapter.createElement(
      node.tagName,
      node.namespaceURI,
      node.attrs.map((a) => ({ ...a })),
    );
    if (isTemplate(node)) {
      const content = defaultTreeAdapter.createDocumentFragment();
      defaultTreeAdapter.setTemplateContent(copy as Template, content);
      for (const child of node.content.childNodes) {
        defaultTreeAdapter.appendChild(content, cloneSubtree(child));
      }
    }
    for (const child of node.childNodes) {
      defaultTreeAdapter.appendChild(copy, cloneSubtree(child));
    }
    return copy;
  }
  if (node.nodeName === '#text') {
    const text: TextNode = { nodeName: '#text', value: (node as TextNode).value, parentNode: null };
    return text;
  }
  if (node.nodeName === '#comment') {
    const comment: CommentNode = {
      nodeName: '#comment',
      data: (node as CommentNode).data,
      parentNode: null,
    };
    return comment;
  }
  // #documentType cannot occur inside an element subtree; shallow-copy defensively.
  return { ...node, parentNode: null };
}

/**
 * Engine-level whitelist of attribute names setAttr may touch. Deliberately
 * tiny: widening it is an explicit engine change with its own review, never
 * a journal payload away.
 *
 * @internal
 */
export const SETATTR_ALLOWED_NAMES: ReadonlySet<string> = new Set(['src']);

/**
 * DRY-RUN: would `ops` apply cleanly to this document? Re-parses the pristine
 * source into a throwaway tree (exactly what serializeSource does at save
 * time, minus the serialization) and applies the ops to it — the pristine
 * `doc` is never touched. Main's op-guard uses this for the clone-id residue
 * cases its cheap prefix rules cannot express, so a push the guard accepts is
 * BY CONSTRUCTION a push the save will accept.
 *
 * @internal
 */
export function tryApplyOps(
  doc: RedraDoc,
  ops: readonly Op[],
): { ok: true } | { ok: false; error: string } {
  const work = parseDocument(doc.source);
  try {
    applyOps(work, ops);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

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
      case 'setAttr': {
        if (!SETATTR_ALLOWED_NAMES.has(op.name)) {
          throw new RedraOpError(
            op,
            `attribute "${op.name}" is not allowed (allowed: ${[...SETATTR_ALLOWED_NAMES].join(', ')})`,
          );
        }
        const el = resolve(op, op.id, 'element');
        const attr = el.attrs.find((a) => a.name === op.name);
        if (attr) attr.value = op.value;
        else el.attrs.push({ name: op.name, value: op.value });
        break;
      }
      case 'cloneBlock': {
        if (!CLONE_ID_RE.test(op.cloneId)) {
          throw new RedraOpError(op, `invalid cloneId "${op.cloneId}" (expected "c<number>")`);
        }
        // Uniqueness against the doc's id map — which already contains the
        // ids registered by previously applied cloneBlocks.
        if (doc.idToNode.has(op.cloneId)) {
          throw new RedraOpError(op, `cloneId "${op.cloneId}" is already in use`);
        }
        const el = resolve(op, op.id, 'element');
        const parent = el.parentNode;
        if (!parent) {
          throw new RedraOpError(op, `element "${op.id}" has no parent to insert the clone into`);
        }
        const copy = cloneSubtree(el) as Element;
        parent.childNodes.splice(parent.childNodes.indexOf(el) + 1, 0, copy);
        copy.parentNode = parent;
        // Register clone ids: root = cloneId, every descendant element =
        // `${cloneId}-${n}` in the SAME deterministic walk order as
        // walkElements (template content before children), so main and the
        // engine derive identical ids without ever exchanging them. The
        // maps are mutated — applyOps only ever runs on throwaway clones of
        // the pristine doc (see serializeSource).
        const idToNode = doc.idToNode as Map<string, Element>;
        const nodeToId = doc.nodeToId as Map<Element, string>;
        idToNode.set(op.cloneId, copy);
        nodeToId.set(copy, op.cloneId);
        let n = 0;
        const register = (d: Element): void => {
          const id = `${op.cloneId}-${++n}`;
          idToNode.set(id, d);
          nodeToId.set(d, id);
        };
        if (isTemplate(copy)) walkElements(copy.content, register);
        walkElements(copy, register);
        break;
      }
    }
  }
}
