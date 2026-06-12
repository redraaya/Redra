/**
 * Inline-formatting helpers for the selection toolbar (Feature 3, v0.2.0).
 *
 * Pure DOM (jsdom-testable), ZERO engine involvement: the markup these
 * produce flows through the existing commit pipeline — normalizeEditedHtml
 * whitelists b/i/a/code, so nothing new can reach the engine.
 */

/**
 * Nearest ancestor-or-self element with `tag` (case-insensitive), walking up
 * from `node` and stopping BEFORE `boundary` (the session element itself is
 * never returned — wrapping the whole editable host is not "inside a tag").
 */
export function closestTag(node: Node | null, tag: string, boundary: Node): HTMLElement | null {
  const upper = tag.toUpperCase();
  for (let n: Node | null = node; n && n !== boundary; n = n.parentNode) {
    if (n.nodeType === 1 && (n as Element).tagName === upper) return n as HTMLElement;
  }
  return null;
}

/** Replace `el` with its children, in place. */
function unwrapElement(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

/**
 * Toggle an inline wrapper tag (v1: 'code' — execCommand has no such
 * command) over the selection range, scoped to `boundary` (the session
 * element):
 *
 * - selection entirely INSIDE a <tag> ancestor → that ancestor is unwrapped
 *   (the whole element, not just the selected slice — "toggle off");
 * - otherwise → the range contents are extracted, nested <tag> wrappers
 *   inside them are dissolved (no <code><code>…), and the result is wrapped
 *   in ONE new <tag>; the range is left selecting the wrapper's contents so
 *   the caller can restore the visual selection.
 *
 * Partial-overlap note (documented limitation): when the selection covers
 * only part of an existing <tag> PLUS outside text, Range.extractContents
 * splits the element per DOM spec — the extracted part is re-wrapped
 * together with the rest of the selection, the part left behind keeps its
 * original tag. Effectively "extend the formatting to cover the selection".
 *
 * Returns 'wrapped' | 'unwrapped' for callers/tests.
 */
export function toggleInlineTag(
  range: Range,
  tag: string,
  boundary: Node,
): 'wrapped' | 'unwrapped' {
  const existing = closestTag(range.commonAncestorContainer, tag, boundary);
  if (existing) {
    unwrapElement(existing);
    return 'unwrapped';
  }
  const doc = boundary.ownerDocument;
  if (!doc) throw new Error('boundary is not attached to a document');
  const contents = range.extractContents();
  for (const nested of Array.from(contents.querySelectorAll(tag))) {
    unwrapElement(nested);
  }
  const wrapper = doc.createElement(tag);
  wrapper.appendChild(contents);
  range.insertNode(wrapper);
  range.selectNodeContents(wrapper);
  return 'wrapped';
}
