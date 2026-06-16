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
 * A plan for applying an inline-tag toggle via a SINGLE
 * `document.execCommand('insertHTML', …)` so the mutation lands on the same
 * native contenteditable undo stack as bold/italic/typing (one ⌘Z reverts
 * it, in correct chronological order). Decision logic mirrors
 * {@link toggleInlineTag}; only the application differs (insertHTML replaces
 * the selection, so the plan also carries the range to select first).
 *
 * - unwrap: select the WHOLE existing `<tag>` ancestor, replace it with its
 *   own inner HTML (wrapper gone) — matches "toggle off the whole element"
 *   even for a partial inner selection.
 * - wrap: keep the current range, replace it with its contents wrapped in one
 *   `<tag>`, nested same-tags dissolved (no `<code><code>`).
 *
 * The caller is expected to have already rejected a collapsed selection
 * (nothing to toggle); this function always returns a plan.
 */
export function computeInlineToggle(
  range: Range,
  tag: string,
  boundary: Node,
): { mode: 'wrapped' | 'unwrapped'; selectRange: Range; html: string } {
  const doc = boundary.ownerDocument;
  if (!doc) throw new Error('boundary is not attached to a document');
  const existing = closestTag(range.commonAncestorContainer, tag, boundary);
  if (existing) {
    // Replace the ENTIRE element (not just the selected slice) with its
    // contents — so selecting the whole element before insertHTML is what
    // makes the unwrap span the whole element, not the user's sub-selection.
    const selectRange = doc.createRange();
    selectRange.selectNode(existing);
    return { mode: 'unwrapped', selectRange, html: existing.innerHTML };
  }
  const contents = range.cloneContents();
  for (const nested of Array.from(contents.querySelectorAll(tag))) {
    unwrapElement(nested);
  }
  const wrapper = doc.createElement(tag);
  wrapper.appendChild(contents);
  return { mode: 'wrapped', selectRange: range, html: wrapper.outerHTML };
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
