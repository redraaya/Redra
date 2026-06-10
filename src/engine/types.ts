import type { DefaultTreeAdapterMap } from 'parse5';

export type Document = DefaultTreeAdapterMap['document'];
export type Element = DefaultTreeAdapterMap['element'];
export type ParentNode = DefaultTreeAdapterMap['parentNode'];
export type Template = DefaultTreeAdapterMap['template'];

/**
 * A parsed Redra document: the pristine parse5 tree plus stable element ids.
 *
 * Opaque to callers — fields are an implementation detail of the engine.
 * Use parseDocument / serializeSource / serializeForView / getElementId /
 * getElementById to interact with it.
 */
export interface RedraDoc {
  /** @internal the original source string, byte-for-byte as it was parsed */
  readonly source: string;
  /** @internal pristine parse5 tree; never mutated by the public API */
  readonly document: Document;
  /** @internal "rN" -> element, in document order */
  readonly idToNode: ReadonlyMap<string, Element>;
  /** @internal element -> "rN" */
  readonly nodeToId: ReadonlyMap<Element, string>;
}

/** Attribute used to mark elements in the view serialization. */
export const REDRA_ID_ATTR = 'data-redra-id';
