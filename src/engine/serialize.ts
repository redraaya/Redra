import { serialize, serializeOuter } from 'parse5';
import { applyOps, type Op } from './ops.js';
import { isTemplate, parseDocument, walkElements } from './parse.js';
import { REDRA_ID_ATTR, type Element, type RedraDoc } from './types.js';

/**
 * Serialize the document for saving — no data-redra-id anywhere: the pristine
 * tree is never stamped, and applyOps runs every editText fragment (captured
 * from the stamped live DOM) through the provenance gate, which verifies each
 * stamp against the pristine source and removes it.
 *
 * With no ops the ORIGINAL source string is returned byte-for-byte: opening
 * and saving an unedited file must not rewrite it (no phantom diffs).
 *
 * With ops: the pristine source is re-parsed into a clone (parseDocument
 * assigns ids with the same walk, so the clone's ids match the original's),
 * the ops are applied in order to the clone, and the clone is serialized.
 * The pristine tree and id maps of `doc` are never touched.
 *
 * @throws RedraOpError when an op references a missing/removed element.
 */
export function serializeSource(doc: RedraDoc, ops: readonly Op[] = []): string {
  if (ops.length === 0) return doc.source;
  const clone = parseDocument(doc.source);
  applyOps(clone, ops);
  return serialize(clone.document);
}

/**
 * The STAMPED outer HTML of the clone a cloneBlock op would create — what
 * main returns from 'ops:cloneBlock' so the preload can insert an
 * immediately-editable live copy (hover/handle/edit all key off the stamps).
 *
 * Composition (the clean one): re-parse the pristine source into a working
 * tree, apply the ACTIVE ops plus the new cloneBlock — exactly what the next
 * save will do — then stamp the clone subtree with the ids applyOps just
 * registered (root = cloneId, descendants = cloneId-n) and serialize it.
 * The working tree is throwaway, so the stamps need no undo; the pristine
 * doc is never touched.
 *
 * @throws RedraOpError when the ops (the cloneBlock included) do not apply.
 */
export function renderCloneFragment(
  doc: RedraDoc,
  activeOps: readonly Op[],
  targetId: string,
  cloneId: string,
): string {
  const work = parseDocument(doc.source);
  applyOps(work, [...activeOps, { type: 'cloneBlock', id: targetId, cloneId }]);
  const root = work.idToNode.get(cloneId);
  if (!root) throw new Error(`cloneBlock applied but "${cloneId}" is not in the id map`); // unreachable
  const stamp = (el: Element): void => {
    const id = work.nodeToId.get(el);
    if (id === undefined) return;
    const existing = el.attrs.find((a) => a.name === REDRA_ID_ATTR);
    if (existing) existing.value = id; // a pre-existing stamp attr in the user's file: ours wins in the view
    else el.attrs.push({ name: REDRA_ID_ATTR, value: id });
  };
  stamp(root);
  if (isTemplate(root)) walkElements(root.content, stamp);
  walkElements(root, stamp);
  return serializeOuter(root);
}

/**
 * parse5 serialization of the pristine tree (normalized form, no stamps).
 * This is what edited output goes through; kept separate so the fidelity of
 * the normalization path stays testable.
 *
 * @internal
 */
export function serializePristine(doc: RedraDoc): string {
  return serialize(doc.document);
}

/**
 * Serialize the document with every element stamped data-redra-id="rN".
 *
 * Implementation: stamp the pristine tree in place, serialize synchronously,
 * then undo every stamp (restoring any pre-existing attribute value), so the
 * pristine tree is bit-identical afterwards. The try/finally guarantees
 * restoration even if serialization throws.
 */
export function serializeForView(doc: RedraDoc): string {
  const undo: Array<() => void> = [];
  for (const [el, id] of doc.nodeToId) {
    const existing = el.attrs.find((a) => a.name === REDRA_ID_ATTR);
    if (existing) {
      const previous = existing.value;
      existing.value = id;
      undo.push(() => {
        existing.value = previous;
      });
    } else {
      const stamped = { name: REDRA_ID_ATTR, value: id };
      el.attrs.push(stamped);
      undo.push(() => {
        const i = el.attrs.indexOf(stamped);
        if (i !== -1) el.attrs.splice(i, 1);
      });
    }
  }
  try {
    return serialize(doc.document);
  } finally {
    for (const restore of undo) restore();
  }
}
