/**
 * Sanitizer for rendered MD block HTML (Stage 1, security-critical).
 *
 * Every block's HTML passes through here after rendering. Trusted markup
 * comes from our own renderer; the DANGER is raw `html` nodes from the
 * .md file, which are emitted verbatim upstream. This pass re-parses the
 * whole block with parse5 (pairing split inline tags on the way), then:
 *
 *  - DROPS dangerous elements with their subtrees (script/style/iframe/…);
 *  - KEEPS unknown-but-harmless elements (figure, section, …) — visual
 *    content survives, but the island is marked read-only (see below);
 *  - STRIPS every attribute not on the per-tag allowlist; url attributes
 *    must pass the safe-scheme check; class survives only for values our
 *    renderer emits (language-*, md-*, al-*);
 *  - data-redra-id survives ONLY in the strict id shape — and the renderer
 *    additionally pre-strips data-redra-* from raw html VALUES, so a file
 *    cannot forge stamps and hijack ops (red-team tested);
 *  - decides island EDITABILITY: an island subtree consisting solely of
 *    EDIT_SAFE elements stays editable; anything else gets
 *    data-redra-readonly="1" on the island root (the preload refuses text
 *    sessions there; move/duplicate/delete still work on the block).
 */
import { parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { isSafeUrl } from './md-render.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];

/** Subtree is removed entirely. */
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea',
  'video', 'audio', 'source', 'track', 'canvas', 'svg', 'math', 'template',
  'slot', 'dialog',
]);

/** Inline/структурные элементы, внутри которых текстовая сессия безопасна и
 *  писатель умеет их сериализовать — остров из ТОЛЬКО таких остаётся
 *  редактируемым. */
const EDIT_SAFE = new Set([
  'u', 'ins', 's', 'del', 'b', 'i', 'em', 'strong', 'code', 'sub', 'sup',
  'mark', 'tg-spoiler', 'br', 'a', 'span', 'p', 'details', 'summary',
  'blockquote',
]);

const ID_RE = /^(m\d+(-\d+)?|c\d+(-\d+)?)$/;
const LANG_CLASS_RE = /^language-[a-zA-Z0-9#+_.-]{1,32}$/;
const KNOWN_CLASSES = new Set([
  'md-task', 'md-task-done', 'md-math', 'md-footnote', 'md-footnote-label',
  'md-fnref', 'al-c', 'al-r',
]);

function isElement(node: P5Node): node is P5Element {
  return 'tagName' in node && typeof (node as P5Element).tagName === 'string';
}

function filterClass(value: string): string {
  return value
    .split(/\s+/)
    .filter((c) => KNOWN_CLASSES.has(c) || LANG_CLASS_RE.test(c))
    .join(' ');
}

function filterAttrs(el: P5Element): void {
  const tag = el.tagName;
  const kept: typeof el.attrs = [];
  for (const attr of el.attrs) {
    const name = attr.name;
    if (name === 'data-redra-id' && ID_RE.test(attr.value)) kept.push(attr);
    else if (name === 'data-redra-readonly' || name === 'data-redra-island') kept.push(attr);
    else if (name === 'href' && tag === 'a' && isSafeUrl(attr.value)) kept.push(attr);
    else if (name === 'src' && tag === 'img' && isSafeUrl(attr.value)) kept.push(attr);
    else if (name === 'alt' && tag === 'img') kept.push(attr);
    else if (name === 'start' && tag === 'ol' && /^\d{1,6}$/.test(attr.value)) kept.push(attr);
    else if (name === 'open' && tag === 'details') kept.push(attr);
    else if (name === 'class') {
      const filtered = filterClass(attr.value);
      if (filtered !== '') kept.push({ name, value: filtered });
    }
  }
  el.attrs = kept;
}

/** Walk + prune in place. Returns true when the subtree contains an element
 *  outside EDIT_SAFE (⇒ enclosing island must go read-only). */
function sanitizeNode(node: P5Parent): boolean {
  let sawUnsafeForEditing = false;
  const children = node.childNodes ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]!;
    if (!isElement(child)) continue; // text/comment nodes stay (comments are inert)
    if (DROP_TAGS.has(child.tagName)) {
      children.splice(i, 1);
      continue;
    }
    filterAttrs(child);
    const childUnsafe = sanitizeNode(child as P5Parent);
    if (childUnsafe || !EDIT_SAFE.has(child.tagName)) sawUnsafeForEditing = true;
  }
  return sawUnsafeForEditing;
}

function findIslandRoots(node: P5Parent, out: P5Element[]): void {
  for (const child of node.childNodes ?? []) {
    if (!isElement(child)) continue;
    if (child.attrs.some((a) => a.name === 'data-redra-island')) out.push(child);
    else findIslandRoots(child as P5Parent, out);
  }
}

/**
 * Sanitize one rendered block. `rootId` is only used for defensive checks —
 * the block's own stamps were emitted by the renderer and survive verbatim.
 */
export function sanitizeBlockHtml(html: string, _rootId: string): string {
  const fragment = parseFragment(html);
  sanitizeNode(fragment as unknown as P5Parent);
  // Island editability: a root whose subtree holds ONLY edit-safe elements
  // is editable; anything else is content we can show but not round-trip
  // from a text session — mark read-only.
  const islands: P5Element[] = [];
  findIslandRoots(fragment as unknown as P5Parent, islands);
  for (const island of islands) {
    const unsafe = (island.childNodes ?? []).some((c) => {
      if (!isElement(c)) return false;
      return !EDIT_SAFE.has(c.tagName) || subtreeUnsafe(c as P5Parent);
    });
    const has = island.attrs.some((a) => a.name === 'data-redra-readonly');
    if (unsafe && !has) island.attrs.push({ name: 'data-redra-readonly', value: '1' });
  }
  return serialize(fragment);
}

function subtreeUnsafe(node: P5Parent): boolean {
  for (const child of node.childNodes ?? []) {
    if (!isElement(child)) continue;
    if (!EDIT_SAFE.has(child.tagName)) return true;
    if (subtreeUnsafe(child as P5Parent)) return true;
  }
  return false;
}

/** Pre-strip data-redra-* from RAW html node values before they ever meet
 *  the parser — a .md file must not be able to forge stamps. */
export function stripForgedStamps(rawHtml: string): string {
  return rawHtml.replace(/\sdata-redra-[a-z-]*\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ');
}
