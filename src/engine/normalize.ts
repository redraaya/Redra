import { defaultTreeAdapter, html, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { Element } from './types.js';

type ChildNode = DefaultTreeAdapterMap['childNode'];
type TextNode = DefaultTreeAdapterMap['textNode'];

/** Inline formatting elements that survive normalization (bare, lowercase). */
const KEPT_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'a',
  'code',
  'br',
  'sub',
  'sup',
  'mark',
]);

/** Elements removed together with their entire content. */
const DROPPED_TAGS = new Set([
  'script',
  'style',
  'template',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
]);

/** URL schemes allowed in <a href>. Anything else loses the attribute. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

function isElementNode(node: ChildNode): node is Element {
  return 'tagName' in node;
}

function isTextNode(node: ChildNode): node is TextNode {
  return node.nodeName === '#text';
}

function isBr(node: ChildNode): boolean {
  return isElementNode(node) && node.tagName === 'br';
}

/**
 * True when the href may be kept: relative/anchor references and the
 * SAFE_SCHEMES. The check mirrors the HTML URL parser enough to not be
 * fooled: tab/newline/CR are stripped everywhere, leading C0 controls and
 * spaces are stripped, the scheme match is case-insensitive. parse5 has
 * already decoded entities by the time the value gets here.
 */
function isSafeHref(value: string): boolean {
  const cleaned = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!scheme) return true; // relative, anchor, or schemeless reference
  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase());
}

/** Attributes that survive on a kept element (rule: only safe href on <a>). */
function filterAttrs(el: Element): Element['attrs'] {
  if (el.tagName !== 'a') return [];
  return el.attrs.filter((a) => a.name === 'href' && isSafeHref(a.value));
}

/**
 * Already-emitted output counts as "preceding content" for the block-break
 * rule only if something visible is there: an element, or text with a
 * non-whitespace character. Removed junk (scripts, comments) and pure
 * formatting whitespace render as nothing, so an unwrapped div after them
 * starts the first visual line and gets no <br>.
 */
function hasVisibleContent(emitted: readonly ChildNode[]): boolean {
  return emitted.some((n) => isElementNode(n) || (isTextNode(n) && n.value.trim() !== ''));
}

/**
 * Collapse runs of MORE THAN TWO strictly adjacent <br> into exactly two.
 * Only adjacency counts: a text node between brs breaks the run, because
 * normalization never deletes user text (rule 5).
 */
function collapseBrRuns(nodes: ChildNode[]): ChildNode[] {
  const out: ChildNode[] = [];
  let run = 0;
  for (const node of nodes) {
    run = isBr(node) ? run + 1 : 0;
    if (run > 2) continue;
    out.push(node);
  }
  return out;
}

/**
 * The single recursive transform: maps a list of sibling nodes to the
 * normalized list, in order.
 *
 * - text stays as-is, comments vanish;
 * - DROPPED_TAGS vanish with their whole subtree;
 * - KEPT_TAGS keep only allowed attributes and recurse into children;
 * - everything else is unwrapped (children hoisted, recursed); a div/p with
 *   visible content already emitted contributes one <br> first, preserving
 *   the line break contenteditable expressed as a block;
 * - finally <br> runs longer than two collapse to two.
 */
function normalizeSiblings(nodes: readonly ChildNode[]): ChildNode[] {
  const out: ChildNode[] = [];
  for (const node of nodes) {
    if (node.nodeName === '#comment') continue;
    if (!isElementNode(node)) {
      if (isTextNode(node)) out.push(node);
      continue;
    }
    if (DROPPED_TAGS.has(node.tagName)) continue;
    if (KEPT_TAGS.has(node.tagName)) {
      node.attrs = filterAttrs(node);
      node.childNodes = normalizeSiblings(node.childNodes);
      for (const child of node.childNodes) child.parentNode = node;
      out.push(node);
      continue;
    }
    // Unwrap: the element disappears, its (normalized) children remain.
    if ((node.tagName === 'div' || node.tagName === 'p') && hasVisibleContent(out)) {
      out.push(defaultTreeAdapter.createElement('br', html.NS.HTML, []));
    }
    out.push(...normalizeSiblings(node.childNodes));
  }
  return collapseBrRuns(out);
}

/**
 * Normalize contenteditable-produced HTML before it is recorded as an
 * editText payload: keep only bare inline formatting (b, strong, i, em, u,
 * s, a, code, br, sub, sup, mark), strip all attributes except a safe href
 * on <a>, turn div/p line blocks into <br>, drop scripts/styles/comments
 * with their content, and leave text untouched (no whitespace collapsing).
 *
 * Pure parse5, no DOM — safe to call from the engine or a preload bundle.
 * Idempotent: normalizing already-normalized output is a no-op.
 */
export function normalizeEditedHtml(raw: string): string {
  const fragment = parseFragment(raw);
  fragment.childNodes = normalizeSiblings(fragment.childNodes);
  for (const child of fragment.childNodes) child.parentNode = fragment;
  return serialize(fragment);
}
