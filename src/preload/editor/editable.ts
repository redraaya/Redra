import { REDRA_ID_ATTR } from '../../engine/types.js';

/**
 * Block-level elements that host an edit session directly («тыц и пиши»).
 */
export const BLOCK_EDITABLE_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'caption',
  'figcaption',
  'blockquote',
  'pre',
  'dt',
  'dd',
]);

/**
 * Inline text carriers: clicking one edits its nearest BLOCK_EDITABLE
 * ancestor. When no such ancestor exists (e.g. <span> directly inside a
 * <div>), the outermost contiguous inline carrier is edited instead.
 */
export const INLINE_EDITABLE_TAGS = new Set([
  'a',
  'button',
  'span',
  'label',
  'summary',
  'em',
  'strong',
  'b',
  'i',
  'u',
  's',
  'code',
  'mark',
  'small',
  'sub',
  'sup',
]);

/**
 * Resolve the element an edit session should attach to for a click on
 * `target`, or null when the click is not over editable source content.
 *
 * Rules (A1):
 * - the click target itself must carry data-redra-id — script-created
 *   elements are not in the source and are never editable;
 * - walk ancestors-or-self: the first BLOCK_EDITABLE tag (with id) wins;
 * - inline carriers accumulate on the way up; hitting a non-editable
 *   boundary: if the boundary element is a stamped TEXT-BEARING container
 *   (direct non-whitespace text child — the «div-карточка» pattern of
 *   AI-generated reports, field bug #1), the container itself is edited;
 *   otherwise fall back to the outermost stamped inline carrier seen, or null.
 */
export function resolveEditable(target: Element): HTMLElement | null {
  if (target.nodeType !== 1 || !target.hasAttribute(REDRA_ID_ATTR)) return null;

  let topInline: Element | null = null;
  for (let el: Element | null = target; el; el = el.parentElement) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const stamped = el.hasAttribute(REDRA_ID_ATTR);
    if (BLOCK_EDITABLE_TAGS.has(tag)) {
      // An unstamped block ancestor is a script-created wrapper: stop here.
      return stamped ? (el as HTMLElement) : (topInline as HTMLElement | null);
    }
    if (INLINE_EDITABLE_TAGS.has(tag)) {
      if (stamped) topInline = el;
      continue;
    }
    // Non-editable boundary. Card-like containers (loose text directly in a
    // stamped div/section/…) host the session themselves — one session for
    // the whole card, so bold fragments and bare text edit seamlessly.
    if (stamped && hasDirectText(el)) return el as HTMLElement;
    break;
  }
  return topInline as HTMLElement | null;
}

/** True when the element has a direct non-whitespace text node child. */
function hasDirectText(el: Element): boolean {
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]!;
    if (child.nodeType === 3 && (child.textContent ?? '').trim() !== '') return true;
  }
  return false;
}
