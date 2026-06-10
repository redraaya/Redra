import { serialize } from 'parse5';
import { REDRA_ID_ATTR, type RedraDoc } from './types.js';

/**
 * Serialize the document for saving — no data-redra-id anywhere.
 *
 * With no ops the ORIGINAL source string is returned byte-for-byte: opening
 * and saving an unedited file must not rewrite it (no phantom diffs).
 */
export function serializeSource(doc: RedraDoc): string {
  return doc.source;
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
