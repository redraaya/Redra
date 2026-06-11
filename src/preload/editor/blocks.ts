import { REDRA_ID_ATTR } from '../../engine/types.js';

/** Computed display values that make an element a block candidate. */
const BLOCKISH_DISPLAY = new Set(['block', 'flex', 'grid', 'table', 'list-item', 'flow-root']);

/**
 * Default-display fallback for environments where getComputedStyle yields
 * an empty display (jsdom without a UA stylesheet). Mirrors the HTML UA
 * defaults for the same BLOCKISH_DISPLAY set.
 */
const DEFAULT_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

function isBlockish(el: Element, win: Window): boolean {
  let display = '';
  try {
    display = win.getComputedStyle(el).display;
  } catch {
    /* fall through to tag defaults */
  }
  if (display === '') return DEFAULT_BLOCK_TAGS.has(el.tagName.toLowerCase());
  return BLOCKISH_DISPLAY.has(display);
}

/**
 * Resolve the BLOCK the hover UI (wash + handle) should attach to, or null.
 *
 * Pragmatic v1 rule (A2): walking up from the hover target, candidates are
 * ancestors-or-self that carry data-redra-id and have block-ish computed
 * display; the block is the DEEPEST candidate whose parent is <body>, or
 * whose parent is itself block-ish AND contains at least one other element
 * child (i.e. the candidate has element siblings — it is a unit among
 * peers, not a sole wrapper). Covers flat reports (children of body),
 * nested layouts (container > section > p), slide decks (body > .slide >
 * h1+p) and single-root apps (#app's children) — see tests.
 */
export function resolveBlock(target: Element, win: Window): HTMLElement | null {
  const body = target.ownerDocument.body;
  for (let el: Element | null = target; el && el !== body; el = el.parentElement) {
    if (el.nodeType !== 1) break;
    if (el.tagName.toLowerCase() === 'html') break;
    if (!el.hasAttribute(REDRA_ID_ATTR)) continue;
    if (!isBlockish(el, win)) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const qualifies =
      parent === body || (isBlockish(parent, win) && parent.children.length >= 2);
    if (qualifies) return el as HTMLElement; // first match walking up = deepest
  }
  return null;
}
