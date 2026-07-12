import { defaultTreeAdapter, html, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { REDRA_ID_ATTR } from './types.js';
import type { Element } from './types.js';

type ChildNode = DefaultTreeAdapterMap['childNode'];
type TextNode = DefaultTreeAdapterMap['textNode'];

/**
 * Inline formatting elements that survive normalization (bare, lowercase).
 * Shared with the provenance gate in ops.ts: a stamped element whose claim
 * does not verify is downgraded by these same NEW-content rules.
 *
 * @internal
 */
export const KEPT_TAGS = new Set([
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

/**
 * Elements removed together with their entire content. Shared with the
 * provenance gate in ops.ts: these tags never survive without verified
 * provenance.
 *
 * @internal
 */
export const DROPPED_TAGS = new Set([
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
 *
 * Shared with the provenance gate in ops.ts (downgrade path for <a>).
 *
 * @internal
 */
export function isSafeHref(value: string): boolean {
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

/** True when the element carries the stamp, i.e. it CLAIMS to be original file markup. */
function isStamped(el: Element): boolean {
  return el.attrs.some((a) => a.name === REDRA_ID_ATTR);
}

/**
 * Tags whose stamped content passes through verbatim (no recursion).
 * Mirrors VERBATIM_TAGS in the ops.ts gate, which later requires that
 * content to be byte-identical to the pristine source.
 */
const STAMPED_VERBATIM_TAGS = new Set(['script', 'style', 'template']);

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
 * - a STAMPED element (data-redra-id) CLAIMS to be the file's original
 *   markup: ANY tag survives with ALL its attributes as-is — INCLUDING the
 *   stamp itself — no <br> conversion, children recursed with these same
 *   rules; script/style/template keep their content verbatim. Nothing is
 *   sanitized here: the stamp is only a claim, and applyOps verifies it
 *   against the pristine source before anything reaches the saved file;
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
function normalizeSiblings(
  nodes: readonly ChildNode[],
  precededByVisible: boolean,
  kept: ReadonlySet<string>,
): ChildNode[] {
  const out: ChildNode[] = [];
  for (const node of nodes) {
    if (node.nodeName === '#comment') continue;
    if (!isElementNode(node)) {
      if (isTextNode(node)) out.push(node);
      continue;
    }
    if (isStamped(node)) {
      // Claims to be original markup from the user's file: passes through
      // whole, attributes untouched, stamp kept — applyOps is the gate that
      // verifies the claim against the pristine source.
      if (!STAMPED_VERBATIM_TAGS.has(node.tagName)) {
        // script/style/template content stays byte-identical (stamps inside
        // a template's content included — the gate strips them after the
        // content check); everything else recurses with these same rules.
        node.childNodes = normalizeSiblings(node.childNodes, false, kept);
        for (const child of node.childNodes) child.parentNode = node;
      }
      out.push(node);
      continue;
    }
    if (DROPPED_TAGS.has(node.tagName)) continue;
    if (kept.has(node.tagName)) {
      node.attrs = filterAttrs(node);
      node.childNodes = normalizeSiblings(
        node.childNodes,
        precededByVisible || hasVisibleContent(out),
        kept,
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
      out.push(...normalizeSiblings(node.childNodes, false, kept));
    } else {
      out.push(
        ...normalizeSiblings(node.childNodes, precededByVisible || hasVisibleContent(out), kept),
      );
    }
  }
  return collapseBrRuns(out);
}

/**
 * Normalize contenteditable-produced HTML before it is recorded as an
 * editText payload. Two modes, decided per element by the data-redra-id
 * stamp:
 *
 * NEW content (unstamped — typed or pasted during the session): keep only
 * bare inline formatting (b, strong, i, em, u, s, a, code, br, sub, sup,
 * mark), strip all attributes except a safe href on <a>, turn block
 * elements (LINE_BREAK_TAGS) into <br>-separated lines, drop
 * scripts/styles/comments with their content, and leave text untouched (no
 * whitespace collapsing).
 *
 * STAMPED elements (data-redra-id present — provenance "came from the
 * user's file"): pass through AS-IS, attributes and stamp included, with no
 * sanitization whatsoever. TRUST MODEL: page scripts share the live DOM and
 * can both forge stamps and mutate attributes of genuinely stamped
 * elements, so a stamp here is only a CLAIM. The claim is verified later by
 * the provenance gate in applyOps (ops.ts) against the pristine source:
 * verified elements get their ORIGINAL attributes back (live mutations and
 * the stamp drop out), unverified ones are downgraded to the NEW-content
 * rules above. Stamps in this function's output are therefore EXPECTED, and
 * stripping/sanitizing here would only destroy legitimate original markup.
 *
 * Pure parse5, no DOM — safe to call from the engine or a preload bundle.
 * Idempotent in both modes: a stamped element passes through unchanged, so
 * re-normalizing the output takes the same branches and is a no-op.
 */
/** Extra bare inline tags a Markdown edit session may legitimately produce
 *  (Telegram-Rich entities the writer knows how to serialize). Kept separate
 *  from KEPT_TAGS so the HTML path — and the provenance gate that imports
 *  KEPT_TAGS — stay byte-identical. */
export const MD_KEPT_TAGS: ReadonlySet<string> = new Set([...KEPT_TAGS, 'tg-spoiler', 'ins', 'del']);

export function normalizeEditedHtml(raw: string, profile: 'html' | 'md' = 'html'): string {
  const kept = profile === 'md' ? MD_KEPT_TAGS : KEPT_TAGS;
  const fragment = parseFragment(raw);
  fragment.childNodes = normalizeSiblings(fragment.childNodes, false, kept);
  for (const child of fragment.childNodes) child.parentNode = fragment;
  return serialize(fragment);
}

/**
 * Attribute values STRICTLY longer than this are stubbed out of editText
 * wire payloads by stubHeavyStampedAttrs. 4 KB comfortably covers any
 * legitimate hand-written attribute while catching embedded data: URIs.
 */
export const HEAVY_STAMPED_ATTR_LIMIT = 4096;

/**
 * Slim an editText payload before it goes over the wire: on STAMPED
 * elements, replace every attribute value longer than
 * HEAVY_STAMPED_ATTR_LIMIT with an empty string.
 *
 * Why this is safe: a stamped element's live attributes are dead weight in
 * the payload anyway — the provenance gate (enforceStampProvenance in
 * ops.ts) replaces a VERIFIED stamped element's attributes wholesale with
 * the ones from the ops-applied source, so a replaced image's real data:
 * URI reaches the saved file via the journal's setAttr op, not via this
 * payload. Without the stub, a multi-MB data: URI inside an edited block
 * would blow the editText size cap and bounce the user's TEXT edit.
 *
 * Untouched on purpose:
 * - the live DOM (callers operate on the serialized payload only);
 * - UNSTAMPED elements — the gate never restores their attributes, so
 *   stubbing would lose real content (normalizeEditedHtml already strips
 *   their attributes anyway, safe href on <a> excepted);
 * - stamped <template> content — the gate requires it to be byte-identical
 *   to the source, so rewriting anything inside would delete the template.
 *
 * Pure parse5, idempotent, engine-adjacent to normalizeEditedHtml (run it
 * on that function's output).
 */
export function stubHeavyStampedAttrs(html: string): string {
  const fragment = parseFragment(html);
  stubSiblings(fragment.childNodes);
  return serialize(fragment);
}

function stubSiblings(nodes: readonly ChildNode[]): void {
  for (const node of nodes) {
    if (!isElementNode(node)) continue;
    if (isStamped(node)) {
      for (const attr of node.attrs) {
        if (attr.value.length > HEAVY_STAMPED_ATTR_LIMIT) attr.value = '';
      }
    }
    // template children live in node.content, which is deliberately NOT
    // walked (verbatim byte-check, see above) — childNodes covers the rest.
    stubSiblings(node.childNodes);
  }
}
