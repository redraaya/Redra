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
 *   boundary (div, section, body, an unstamped wrapper…) falls back to the
 *   outermost stamped inline carrier seen, or null.
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
    break; // non-editable boundary
  }
  return topInline as HTMLElement | null;
}
