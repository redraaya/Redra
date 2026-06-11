import { defaultTreeAdapter, html, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { REDRA_ID_ATTR } from './types.js';
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

/**
 * Block-level elements whose unwrapping contributes one <br> BEFORE their
 * content when visible content already precedes them (break-before only —
 * inline text right after a block continues its line, same as div always
 * did). td/th are deliberately absent: cells unwrap inline, only <tr>
 * breaks. <hr> has no children, so its unwrapping yields just the <br>.
 */
const LINE_BREAK_TAGS = new Set([
  'div',
  'p',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'caption',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'hr',
  'address',
  'fieldset',
  'form',
]);

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
 *
 * Protocol-relative `//host` hrefs are kept on purpose: they are not
 * executable, and Cmd+click opens them in an external browser anyway.
 */
function isSafeHref(value: string): boolean {
  const cleaned = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!scheme) return true; // relative, anchor, or schemeless reference
  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase());
}

/** Attributes that survive on a kept NEW element (rule: only safe href on <a>). */
function filterAttrs(el: Element): Element['attrs'] {
  if (el.tagName !== 'a') return [];
  return el.attrs.filter((a) => a.name === 'href' && isSafeHref(a.value));
}

/** True when the element carries the stamp, i.e. it is ORIGINAL file markup. */
function isStamped(el: Element): boolean {
  return el.attrs.some((a) => a.name === REDRA_ID_ATTR);
}

/**
 * Attributes that survive on a STAMPED element: everything the user's file
 * had, minus (a) the stamp itself, (b) on* event handlers (defense: the
 * saved file must not gain handlers we cannot vouch for via contenteditable
 * shuffling), (c) href/src values with executable schemes
 * (javascript:/vbscript:/data: — anything isSafeHref rejects); the
 * attribute goes, the element stays.
 */
function filterStampedAttrs(el: Element): Element['attrs'] {
  return el.attrs.filter((a) => {
    if (a.name === REDRA_ID_ATTR) return false;
    if (/^on/i.test(a.name)) return false;
    if ((a.name === 'href' || a.name === 'src') && !isSafeHref(a.value)) return false;
    return true;
  });
}

/** Tags whose stamped content passes through verbatim (no recursion). */
const STAMPED_VERBATIM_TAGS = new Set(['script', 'style', 'template']);

/** Strip data-redra-id everywhere under `el`, touching nothing else. */
function stripStampsDeep(el: Element): void {
  el.attrs = el.attrs.filter((a) => a.name !== REDRA_ID_ATTR);
  const children =
    el.tagName === 'template' && 'content' in el
      ? (el as DefaultTreeAdapterMap['template']).content.childNodes
      : el.childNodes;
  for (const child of children) {
    if (isElementNode(child)) stripStampsDeep(child);
  }
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
 * - a STAMPED element (data-redra-id) is the file's ORIGINAL markup, not
 *   contenteditable junk: ANY tag survives with all its attributes (minus
 *   the stamp, on* handlers and unsafe href/src — filterStampedAttrs), no
 *   <br> conversion, children recursed with these same rules;
 *   script/style/template keep their content verbatim;
 * - text stays as-is, comments vanish;
 * - unstamped DROPPED_TAGS vanish with their whole subtree;
 * - unstamped KEPT_TAGS keep only allowed attributes and recurse;
 * - every other unstamped element is unwrapped (children hoisted,
 *   recursed); a LINE_BREAK_TAGS block with visible content already before
 *   it contributes one <br> first, preserving the line break
 *   contenteditable expressed as a block;
 * - finally <br> runs longer than two collapse to two.
 *
 * `precededByVisible` carries "visible content was already emitted before
 * this sibling list" across recursion levels, so a block inside an
 * unwrapped inline wrapper (`text<span><div>line</div></span>`) still gets
 * its <br>. Children of a line-break block start a fresh line, so they
 * recurse with `false`.
 */
function normalizeSiblings(nodes: readonly ChildNode[], precededByVisible: boolean): ChildNode[] {
  const out: ChildNode[] = [];
  for (const node of nodes) {
    if (node.nodeName === '#comment') continue;
    if (!isElementNode(node)) {
      if (isTextNode(node)) out.push(node);
      continue;
    }
    if (isStamped(node)) {
      // Original markup from the user's file: passes through whole.
      if (STAMPED_VERBATIM_TAGS.has(node.tagName)) {
        // Original script/style/template content stays byte-identical;
        // only stamps are removed (a stamped template may carry stamped
        // children inside its content fragment).
        stripStampsDeep(node);
        node.attrs = filterStampedAttrs(node);
      } else {
        node.attrs = filterStampedAttrs(node);
        node.childNodes = normalizeSiblings(node.childNodes, false);
        for (const child of node.childNodes) child.parentNode = node;
      }
      out.push(node);
      continue;
    }
    if (DROPPED_TAGS.has(node.tagName)) continue;
    if (KEPT_TAGS.has(node.tagName)) {
      node.attrs = filterAttrs(node);
      node.childNodes = normalizeSiblings(
        node.childNodes,
        precededByVisible || hasVisibleContent(out),
      );
      for (const child of node.childNodes) child.parentNode = node;
      out.push(node);
      continue;
    }
    // Unwrap: the element disappears, its (normalized) children remain.
    if (LINE_BREAK_TAGS.has(node.tagName)) {
      if (precededByVisible || hasVisibleContent(out)) {
        out.push(defaultTreeAdapter.createElement('br', html.NS.HTML, []));
      }
      out.push(...normalizeSiblings(node.childNodes, false));
    } else {
      out.push(...normalizeSiblings(node.childNodes, precededByVisible || hasVisibleContent(out)));
    }
  }
  return collapseBrRuns(out);
}

/**
 * Normalize contenteditable-produced HTML before it is recorded as an
 * editText payload: keep only bare inline formatting (b, strong, i, em, u,
 * s, a, code, br, sub, sup, mark), strip all attributes except a safe href
 * on <a>, turn block elements (LINE_BREAK_TAGS) into <br>-separated lines,
 * drop scripts/styles/comments
 * with their content, and leave text untouched (no whitespace collapsing).
 *
 * Pure parse5, no DOM — safe to call from the engine or a preload bundle.
 * Idempotent: normalizing already-normalized output is a no-op.
 */
export function normalizeEditedHtml(raw: string): string {
  const fragment = parseFragment(raw);
  fragment.childNodes = normalizeSiblings(fragment.childNodes, false);
  for (const child of fragment.childNodes) child.parentNode = fragment;
  return serialize(fragment);
}
