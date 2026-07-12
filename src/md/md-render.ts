/**
 * Pristine mdast → stamped HTML (the derived view the doc window shows).
 *
 * Owning this renderer (instead of a hast pipeline) keeps it the exact
 * mirror of md-writer: both speak the same bounded vocabulary, which is
 * what makes "writer = gate" true (see the plan). ~350 lines, no deps.
 *
 * STAMPING: within block i, stamped elements get ids in pre-order emission
 * order — the root element `m<i>`, descendants `m<i>-1`, `m<i>-2`, …
 * The SAME function renders a block for the full document and for the
 * save-time materialization, so id equality across contexts holds by
 * construction (and is pinned by tests).
 *
 * Raw `html` nodes are emitted as-is here and neutralized by the
 * md-sanitize pass that every block's HTML goes through afterwards —
 * rendering is only ever exposed via renderBlockHtml/renderDocumentBody,
 * which apply it.
 */
import type { MdBlockEntry } from './md-types.js';
import { sanitizeBlockHtml, stripForgedStamps } from './md-sanitize.js';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESC[ch]!);
}

/**
 * http/https/mailto/tg/relative only — never javascript:, data:, vbscript:…
 *
 * Evaluate the form a BROWSER would resolve, not the raw string: browsers
 * strip TAB/LF/CR anywhere and trim leading C0 controls before reading the
 * scheme, so "java&#9;script:" and "&#1;javascript:" both become
 * "javascript:" and must be rejected. Missing this is a live XSS (found by
 * the Stage-1 red-team).
 */
export function isSafeUrl(url: string): boolean {
  const cleaned = url
    .replace(/[\t\n\r]/g, '') // browsers remove these anywhere in the URL
    .replace(/^[\u0000-\u0020]+/, '') // …and trim leading controls/space
    .replace(/[\u0000-\u0020]+$/, '');
  if (cleaned === '') return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!scheme) return true; // relative — safe
  return /^(https?|mailto|tg)$/i.test(scheme[1]!);
}

const LANG_RE = /^[a-zA-Z0-9#+_.-]{1,32}$/;

export interface MdDefinition {
  url: string;
  title: string | null;
}

interface RenderState {
  rootId: string;
  next: number; // 0 → root itself, then -1, -2, …
  /** identifier → definition, for resolving reference-style links/images. */
  defs: ReadonlyMap<string, MdDefinition>;
}

/** Collect every reference-link/image definition in a tree (identifier → url). */
export function collectDefinitions(root: { children?: unknown[] }): Map<string, MdDefinition> {
  const map = new Map<string, MdDefinition>();
  const walk = (node: { type?: string; identifier?: string; url?: string; title?: string | null; children?: unknown[] }): void => {
    if (node.type === 'definition' && node.identifier) {
      map.set(node.identifier.toLowerCase(), { url: node.url ?? '', title: node.title ?? null });
    }
    for (const c of node.children ?? []) walk(c as typeof node);
  };
  walk(root as Parameters<typeof walk>[0]);
  return map;
}

function stampId(state: RenderState): string {
  const id = state.next === 0 ? state.rootId : `${state.rootId}-${state.next}`;
  state.next++;
  return id;
}

type AnyNode = {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  spread?: boolean;
  lang?: string | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  align?: Array<'left' | 'right' | 'center' | null> | null;
  identifier?: string;
  label?: string | null;
  children?: AnyNode[];
};

function renderChildren(node: AnyNode, s: RenderState): string {
  return (node.children ?? []).map((c) => renderNode(c, s)).join('');
}

function renderNode(node: AnyNode, s: RenderState): string {
  switch (node.type) {
    // ---- blocks -----------------------------------------------------------
    case 'paragraph':
      return `<p data-redra-id="${stampId(s)}">${renderChildren(node, s)}</p>`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, node.depth ?? 1));
      return `<h${level} data-redra-id="${stampId(s)}">${renderChildren(node, s)}</h${level}>`;
    }
    case 'thematicBreak':
      return `<hr data-redra-id="${stampId(s)}">`;
    case 'blockquote':
      return `<blockquote data-redra-id="${stampId(s)}">${renderChildren(node, s)}</blockquote>`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start =
        node.ordered && node.start != null && node.start !== 1 ? ` start="${node.start}"` : '';
      return `<${tag}${start} data-redra-id="${stampId(s)}">${renderChildren(node, s)}</${tag}>`;
    }
    case 'listItem': {
      const id = stampId(s);
      const task =
        node.checked === true
          ? ' class="md-task md-task-done"'
          : node.checked === false
            ? ' class="md-task"'
            : '';
      return `<li${task} data-redra-id="${id}">${renderListItemChildren(node, s)}</li>`;
    }
    case 'code': {
      const id = stampId(s);
      const lang =
        node.lang && LANG_RE.test(node.lang) ? ` class="language-${escapeHtml(node.lang)}"` : '';
      return `<pre data-redra-id="${id}"><code${lang}>${escapeHtml(node.value ?? '')}</code></pre>`;
    }
    case 'math':
      return `<pre class="md-math" data-redra-id="${stampId(s)}"><code>${escapeHtml(node.value ?? '')}</code></pre>`;
    case 'table': {
      const id = stampId(s);
      const rows = (node.children ?? [])
        .map((row, ri) => renderTableRow(row, ri, s, node.align))
        .join('');
      return `<table data-redra-id="${id}">${rows}</table>`;
    }
    case 'definition':
      // Reference-link definitions have no visual form. No element, no id —
      // the block stays in the table as untouchable verbatim bytes.
      return '';
    case 'footnoteDefinition': {
      const id = stampId(s);
      const label = escapeHtml(node.label ?? node.identifier ?? '');
      return `<div class="md-footnote" data-redra-id="${id}"><span class="md-footnote-label">${label}</span>${renderChildren(node, s)}</div>`;
    }
    case 'html':
      // Raw HTML from the file: forged data-redra-* stamps are stripped
      // BEFORE the string ever meets a parser; the sanitizer then vets the
      // rest (dangerous tags dropped, attrs whitelisted). Inline html nodes
      // land here too — the sanitizer re-parses the whole block so split
      // tags (<u>…</u>) pair up naturally.
      return stripForgedStamps(node.value ?? '');

    // ---- inlines ----------------------------------------------------------
    case 'text':
      return escapeHtml(node.value ?? '');
    case 'strong':
      return `<strong>${renderChildren(node, s)}</strong>`;
    case 'emphasis':
      return `<em>${renderChildren(node, s)}</em>`;
    case 'delete':
      return `<s>${renderChildren(node, s)}</s>`;
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`;
    case 'inlineMath':
      return `<span class="md-math">${escapeHtml(node.value ?? '')}</span>`;
    case 'tgSpoiler':
      return `<tg-spoiler>${renderChildren(node, s)}</tg-spoiler>`;
    case 'mdMark':
      return `<mark>${renderChildren(node, s)}</mark>`;
    case 'break':
      return '<br>';
    case 'link': {
      const href = node.url && isSafeUrl(node.url) ? escapeHtml(node.url) : '';
      return `<a href="${href}">${renderChildren(node, s)}</a>`;
    }
    case 'image': {
      const id = stampId(s);
      const src = node.url && isSafeUrl(node.url) ? escapeHtml(node.url) : '';
      return `<img data-redra-id="${id}" src="${src}" alt="${escapeHtml(node.alt ?? '')}">`;
    }
    case 'footnoteReference':
      return `<sup class="md-fnref">${escapeHtml(node.label ?? node.identifier ?? '')}</sup>`;
    case 'linkReference': {
      // Resolve against the doc's definitions so an edit round-trips as a real
      // inline link (never a plain-text drop that orphans the definition). The
      // definition line stays in the file for any other references to it.
      const def = node.identifier ? s.defs.get(node.identifier.toLowerCase()) : undefined;
      const inner = renderChildren(node, s) || escapeHtml(node.label ?? node.identifier ?? '');
      if (!def) return inner; // unknown reference: readable text
      return `<a href="${isSafeUrl(def.url) ? escapeHtml(def.url) : ''}">${inner}</a>`;
    }
    case 'imageReference': {
      const def = node.identifier ? s.defs.get(node.identifier.toLowerCase()) : undefined;
      if (!def) return escapeHtml(node.alt ?? node.label ?? node.identifier ?? '');
      const id = stampId(s);
      return `<img data-redra-id="${id}" src="${isSafeUrl(def.url) ? escapeHtml(def.url) : ''}" alt="${escapeHtml(node.alt ?? '')}">`;
    }
    default:
      // Unknown node kind: render children if any, else nothing. The block's
      // bytes are still preserved unless the user edits this very block.
      return node.children ? renderChildren(node, s) : '';
  }
}

/** Tight lists: mdast wraps each item's text in a paragraph even when the
 *  list is tight — unwrap single tight paragraphs so <li> holds inline
 *  content directly (matches how the writer re-emits and keeps editing
 *  sessions per-<li>, not per-phantom-<p>). The phantom paragraph is NOT
 *  stamped (it does not exist as an editable element). */
function renderListItemChildren(node: AnyNode, s: RenderState): string {
  const children = node.children ?? [];
  if (!node.spread && children.length >= 1 && children.every((c) => c.type === 'paragraph' || c.type === 'list')) {
    return children
      .map((c) => (c.type === 'paragraph' ? renderChildren(c, s) : renderNode(c, s)))
      .join('');
  }
  return renderChildren(node, s);
}

function renderTableRow(
  row: AnyNode,
  rowIndex: number,
  s: RenderState,
  align?: AnyNode['align'],
): string {
  const id = stampId(s);
  const cells = (row.children ?? [])
    .map((cell, ci) => renderTableCell(cell, ci, rowIndex === 0, s, align))
    .join('');
  return `<tr data-redra-id="${id}">${cells}</tr>`;
}

function renderTableCell(
  cell: AnyNode,
  columnIndex: number,
  isHeader: boolean,
  s: RenderState,
  align?: AnyNode['align'],
): string {
  const id = stampId(s);
  const tag = isHeader ? 'th' : 'td';
  const a = align?.[columnIndex];
  const cls = a === 'center' ? ' class="al-c"' : a === 'right' ? ' class="al-r"' : '';
  return `<${tag}${cls} data-redra-id="${id}">${renderChildren(cell, s)}</${tag}>`;
}

/**
 * Render ONE top-level block to sanitized, stamped HTML. The same entry
 * point serves the live view and the save-time materialization.
 *
 * A top-level raw-HTML block becomes an ISLAND: wrapped in a stamped div so
 * the block handle (move/duplicate/delete) works on it; the sanitizer marks
 * it read-only when its content exceeds the edit-safe vocabulary.
 */
const NO_DEFS: ReadonlyMap<string, MdDefinition> = new Map();

export function renderBlockHtml(
  block: MdBlockEntry,
  defs: ReadonlyMap<string, MdDefinition> = NO_DEFS,
): string {
  const state: RenderState = { rootId: block.rootId, next: 0, defs };
  if ((block.node as AnyNode).type === 'html') {
    const inner = stripForgedStamps((block.node as AnyNode).value ?? '');
    return sanitizeBlockHtml(
      `<div data-redra-id="${block.rootId}" data-redra-island="1">${inner}</div>`,
      block.rootId,
    );
  }
  const raw = renderNode(block.node as AnyNode, state);
  if (raw === '') return '';
  return sanitizeBlockHtml(raw, block.rootId);
}

/** Render every block; join with '\n' for readable served HTML. Definitions are
 *  collected from the block set so reference-style links resolve. */
export function renderDocumentBody(blocks: readonly MdBlockEntry[]): string {
  const defs = new Map<string, MdDefinition>();
  for (const b of blocks) {
    for (const [k, v] of collectDefinitions(b.node as { children?: unknown[] })) defs.set(k, v);
  }
  return blocks.map((b) => renderBlockHtml(b, defs)).filter((h) => h !== '').join('\n');
}
