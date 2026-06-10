import { serialize } from 'parse5';
import { applyOps, type Op } from './ops.js';
import { parseDocument } from './parse.js';
import { REDRA_ID_ATTR, type RedraDoc } from './types.js';

/**
 * Serialize the document for saving — no data-redra-id anywhere.
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
