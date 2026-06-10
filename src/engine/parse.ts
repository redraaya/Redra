import { parse } from 'parse5';
import type { Element, ParentNode, RedraDoc, Template } from './types.js';

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'tagName' in node;
}

/**
 * parse5 keeps a template's children in `el.content` (a DocumentFragment),
 * not in `el.childNodes` — any code touching an element's subtree must check.
 *
 * @internal
 */
export function isTemplate(el: Element): el is Template {
  return el.tagName === 'template' && 'content' in el;
}

/**
 * Pre-order DFS over all elements: visit the element, then its template
 * content (if any), then its children. This order is deterministic, so the
 * same source always yields the same id assignment.
 *
 * This is the single definition of document order in the engine — any code
 * that needs to re-walk a tree with identical id assignment must use it.
 *
 * @internal
 */
export function walkElements(parent: ParentNode, visit: (el: Element) => void): void {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    visit(child);
    if (isTemplate(child)) walkElements(child.content, visit);
    walkElements(child, visit);
  }
}

/**
 * Parse HTML into a pristine tree and assign stable ids "r0", "r1", ... to
 * every element in document order. The tree itself is never mutated — the
 * id maps live alongside it.
 */
export function parseDocument(html: string): RedraDoc {
  const document = parse(html);
  const idToNode = new Map<string, Element>();
  const nodeToId = new Map<Element, string>();
  let next = 0;
  walkElements(document, (el) => {
    const id = `r${next++}`;
    idToNode.set(id, el);
    nodeToId.set(el, id);
  });
  return { document, idToNode, nodeToId, source: html };
}

/** Returns the stable id of a node from this document, if it has one. */
export function getElementId(doc: RedraDoc, node: Element): string | undefined {
  return doc.nodeToId.get(node);
}

/** Returns the element with the given stable id, if it exists. */
export function getElementById(doc: RedraDoc, id: string): Element | undefined {
  return doc.idToNode.get(id);
}
