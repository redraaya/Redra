/**
 * HTML → Markdown writer (Stage 2; the correctness core, plan risk R1).
 *
 * Input is a block-scoped parse5 fragment whose vocabulary is BOUNDED: it
 * came from our own renderer plus the md normalize profile, both already
 * sanitized. The writer is therefore the save-time GATE: an element outside
 * the vocabulary contributes only its TEXT CONTENT — unvetted markup can
 * never reach the file. Output style (bold/bullet/fence/spoiler forms)
 * comes from the flavor profile so edits blend into the file's own dialect.
 *
 * Escaping model:
 *  - inline text: backslash-escape the construct starters  \ ` * _ [ ] <
 *    plus the pair-forming sequences || == ~~ (first char of each pair) and
 *    & when it would read as a character reference; | additionally inside
 *    table cells;
 *  - line starts (paragraph assembly): #  >  - + =  digit.  digit)  and
 *    hr-lookalikes get a leading backslash so a paragraph line never turns
 *    into a heading/list/quote on re-parse;
 *  - code spans/fences: backtick-run lengthening, space padding;
 *  - link destinations: <>-wrapped when they contain spaces or parens.
 */
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { isSafeUrl } from './md-render.js';
import type { MdFlavor } from './md-flavor.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
const isText = (n: P5Node): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text';

function attr(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}
function hasClass(el: P5Element, cls: string): boolean {
  return (attr(el, 'class') ?? '').split(/\s+/).includes(cls);
}
function textContent(node: P5Node): string {
  if (isText(node)) return node.value;
  if (!isElement(node)) return '';
  return (node.childNodes ?? []).map(textContent).join('');
}
/** textContent that keeps LINE BREAKS: a <br> becomes `sep` (pasted code from
 *  web pages separates lines with <br>; textContent would fuse them). */
function textContentBr(node: P5Node, sep: string): string {
  if (isText(node)) return node.value;
  if (!isElement(node)) return '';
  if (node.tagName === 'br') return sep;
  return (node.childNodes ?? []).map((c) => textContentBr(c, sep)).join('');
}

// --- inline escaping ---------------------------------------------------------

function escapeInline(text: string, inTable: boolean): string {
  let out = text
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]<])/g, '\\$1')
    .replace(/&(?=[a-zA-Z0-9#]+;)/g, '\\&')
    .replace(/\|\|/g, '\\|\\|')
    .replace(/==/g, '\\==')
    .replace(/~~/g, '\\~~');
  if (inTable) out = out.replace(/\|/g, '\\|');
  return out;
}

/** A paragraph/cell line must not re-parse as a block construct. */
function escapeLineStart(line: string): string {
  if (/^\s*(#{1,6}\s|>|[-+*]\s|\d{1,9}[.)]\s|=+\s*$|(-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$)/.test(line)) {
    return line.replace(/^(\s*)/, '$1\\');
  }
  return line;
}

function codeSpan(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const max = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const ticks = '`'.repeat(max + 1);
  const pad = content.startsWith('`') || content.endsWith('`') || content === '' ? ' ' : '';
  return `${ticks}${pad}${content}${pad}${ticks}`;
}

/** '[t](url "Title")' — the title attr round-trips (render carries it). */
function linkTitle(node: P5Element): string {
  const title = attr(node, 'title');
  if (title === undefined || title === '') return '';
  return ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function linkDest(url: string): string {
  if (url === '') return '<>';
  if (/[\s()]/.test(url)) return `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
  return url;
}

/**
 * Serialize an island subtree back to HTML for the .md file. The writer is
 * the SAVE GATE: an editText payload on an island bypasses render-time
 * sanitization, so this must RE-SANITIZE — drop dangerous elements and every
 * attribute not on the safe allowlist (no on*, no style, no javascript:/data:
 * urls, no forged stamps). Emitting island markup verbatim was a live
 * writer-gate bypass (Stage-1/2 red-team).
 */
const ISLAND_DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link',
  'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'video',
  'audio', 'source', 'track', 'canvas', 'svg', 'math', 'template', 'slot', 'dialog',
]);
const ISLAND_VOID_TAGS = new Set(['br', 'img', 'hr', 'wbr', 'col']);
const ISLAND_LANG_CLASS = /^language-[a-zA-Z0-9#+_.-]{1,32}$/;

function islandAttrString(node: P5Element): string {
  const kept: string[] = [];
  for (const a of node.attrs) {
    const name = a.name.toLowerCase();
    if (name.startsWith('data-redra-') || name.startsWith('on') || name === 'style') continue;
    if ((name === 'href' || name === 'src') && !isSafeUrl(a.value)) continue;
    const allowed =
      name === 'href' || name === 'src' || name === 'alt' || name === 'title' ||
      name === 'open' || name === 'colspan' || name === 'rowspan' ||
      ((name === 'start' || name === 'colspan' || name === 'rowspan') && /^\d{1,6}$/.test(a.value));
    if (name === 'class') {
      const filtered = a.value
        .split(/\s+/)
        .filter((c) => ISLAND_LANG_CLASS.test(c))
        .join(' ');
      if (filtered !== '') kept.push(` class="${filtered}"`);
      continue;
    }
    if (!allowed) continue;
    kept.push(` ${name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
  }
  return kept.join('');
}

function islandHtml(node: P5Node): string {
  if (isText(node)) {
    return node.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (!isElement(node)) return '';
  const tag = node.tagName.toLowerCase();
  if (ISLAND_DROP_TAGS.has(tag)) return ''; // subtree dropped, security-critical
  const attrs = islandAttrString(node);
  const inner = (node.childNodes ?? []).map(islandHtml).join('');
  if (ISLAND_VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

// --- inline writer -------------------------------------------------------------

interface Ctx {
  flavor: MdFlavor;
  eol: string;
  inTable: boolean;
}

function writeInlineChildren(el: P5Element, ctx: Ctx): string {
  return (el.childNodes ?? []).map((c) => writeInlineNode(c, ctx)).join('');
}

function writeInlineNode(node: P5Node, ctx: Ctx): string {
  if (isText(node)) return escapeInline(node.value, ctx.inTable);
  if (!isElement(node)) return '';
  const f = ctx.flavor;
  switch (node.tagName) {
    case 'strong':
    case 'b':
      return wrapNonEmpty(writeInlineChildren(node, ctx), f.bold);
    case 'em':
    case 'i':
      return wrapNonEmpty(writeInlineChildren(node, ctx), f.italic);
    case 's':
    case 'del':
    case 'strike':
      return wrapNonEmpty(writeInlineChildren(node, ctx), f.strike);
    case 'u':
    case 'ins': {
      const tag = f.underline === 'ins' ? 'ins' : 'u';
      const inner = writeInlineChildren(node, ctx);
      return inner === '' ? '' : `<${tag}>${inner}</${tag}>`;
    }
    case 'tg-spoiler': {
      const inner = writeInlineChildren(node, ctx);
      if (inner === '') return '';
      return f.spoiler === 'tag' ? `<tg-spoiler>${inner}</tg-spoiler>` : `||${inner}||`;
    }
    case 'mark':
      return wrapNonEmpty(writeInlineChildren(node, ctx), '==');
    case 'sub':
      return writeInlineChildren(node, ctx) === ''
        ? ''
        : `<sub>${writeInlineChildren(node, ctx)}</sub>`;
    case 'sup':
      // A footnote reference renders as <sup class="md-fnref">label</sup> — it
      // must round-trip to [^label], not literal <sup> HTML (data loss).
      if (hasClass(node, 'md-fnref')) return `[^${textContent(node)}]`;
      return writeInlineChildren(node, ctx) === ''
        ? ''
        : `<sup>${writeInlineChildren(node, ctx)}</sup>`;
    case 'code':
      return codeSpan(textContentBr(node, ' '));
    case 'span':
      if (hasClass(node, 'md-math')) return `$${textContent(node)}$`;
      return writeInlineChildren(node, ctx); // plain span: transparent
    case 'a': {
      // The writer is a SAVE GATE: an unsafe scheme must never reach the file
      // (an editText payload bypasses render-time sanitization). Blank it, like
      // md-render and islandHtml do — all three URL paths must agree.
      const raw = attr(node, 'href') ?? '';
      const href = isSafeUrl(raw) ? raw : '';
      const inner = writeInlineChildren(node, ctx);
      if (inner === '' && href === '') return '';
      return `[${inner}](${linkDest(href)}${linkTitle(node)})`;
    }
    case 'img': {
      const alt = (attr(node, 'alt') ?? '').replace(/([[\]\\])/g, '\\$1');
      const raw = attr(node, 'src') ?? '';
      const src = isSafeUrl(raw) ? raw : '';
      return `![${alt}](${linkDest(src)}${linkTitle(node)})`;
    }
    case 'br':
      // Single <br> = hard break; the paragraph writer turns <br><br> into a
      // paragraph split before inline writing ever sees them.
      return `\\${ctx.eol}`;
    default:
      // Outside the vocabulary: text content only — the writer IS the gate.
      return escapeInline(textContent(node), ctx.inTable);
  }
}

function wrapNonEmpty(inner: string, marker: string): string {
  if (inner === '') return '';
  // Markers cannot enclose leading/trailing whitespace (CommonMark rule) —
  // move it outside the marker pair.
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner.slice(lead.length))![0];
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (core === '') return inner;
  return `${lead}${marker}${core}${marker}${trail}`;
}

// --- block writer ----------------------------------------------------------------

function writeParagraphLines(el: P5Element, ctx: Ctx): string {
  // <br><br> splits the paragraph in the FILE (documented v1 Enter model).
  const groups: P5Node[][] = [[]];
  let pendingBreak = false;
  for (const child of el.childNodes ?? []) {
    const isBr = isElement(child) && child.tagName === 'br';
    if (isBr && pendingBreak) {
      groups.push([]);
      pendingBreak = false;
      continue;
    }
    if (isBr) {
      pendingBreak = true;
      continue;
    }
    if (pendingBreak) {
      groups[groups.length - 1]!.push({ nodeName: '#br-single' } as unknown as P5Node);
      pendingBreak = false;
    }
    groups[groups.length - 1]!.push(child);
  }
  const paragraphs = groups
    .map((nodes) =>
      nodes
        .map((n) =>
          (n as { nodeName?: string }).nodeName === '#br-single'
            ? `\\${ctx.eol}`
            : writeInlineNode(n, ctx),
        )
        .join(''),
    )
    .map((text) =>
      // Normalize every internal newline (soft breaks carried in text content)
      // to the document's EOL first, so a CRLF file never gets a lone LF.
      text
        .replace(/\r\n|\r|\n/g, ctx.eol)
        .split(ctx.eol)
        .map((line) => escapeLineStart(line))
        .join(ctx.eol)
        .trim(),
    )
    .filter((p) => p !== '');
  return paragraphs.join(ctx.eol + ctx.eol);
}

/** Tags that make a bare <div> a BLOCK CONTAINER rather than one paragraph. */
const BLOCKY_TAGS = new Set([
  'div', 'p', 'ul', 'ol', 'pre', 'blockquote', 'table', 'hr', 'details',
]);

/** Block children a list item can hold — routed through writeBlockElement so
 *  they survive (a code fence / table inside an <li> must not flatten to text). */
const LIST_BLOCK_TAGS = new Set([
  'pre', 'table', 'blockquote', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'details', 'div',
]);

function writeListItems(list: P5Element, ctx: Ctx, indent: string): string[] {
  const ordered = list.tagName === 'ol';
  // The live body is untrusted: only a plain 1-6 digit start survives (the
  // render/sanitize side pins the same shape) — 9e99/-5 would write invalid
  // list markers.
  const startAttr = attr(list, 'start');
  let n = startAttr && /^\d{1,6}$/.test(startAttr) ? Number(startAttr) : 1;
  const lines: string[] = [];
  for (const child of list.childNodes ?? []) {
    if (!isElement(child) || child.tagName !== 'li') continue;
    const marker = ordered ? `${n}. ` : `${ctx.flavor.bullet} `;
    n++;
    // Task state: the REAL checkbox input is the source of truth (the live
    // toggle syncs its `checked` attribute); li classes remain the fallback
    // for content that lost the input (e.g. a paste kept only the classes).
    const box = (child.childNodes ?? []).find(
      (c) => isElement(c) && c.tagName === 'input' && attr(c, 'type') === 'checkbox',
    );
    const task = box
      ? attr(box as P5Element, 'checked') !== undefined
        ? '[x] '
        : '[ ] '
      : hasClass(child, 'md-task')
        ? hasClass(child, 'md-task-done')
          ? '[x] '
          : '[ ] '
        : '';
    const contIndent = indent + ' '.repeat(marker.length);
    // A list item is a sequence of BLOCKS: a loose item has real <p> children
    // (the renderer keeps them) and can contain code/quotes/tables/nested
    // lists; a tight item has bare inline runs. Each block is emitted with a
    // blank line + continuation indent so nothing fuses and no block child is
    // ever dropped to text. A loose item stays loose across a nested list.
    const loose = (child.childNodes ?? []).some((c) => isElement(c) && c.tagName === 'p');
    let inlineRun: P5Node[] = [];
    let firstBlock = true;
    const emitLines = (text: string): void => {
      if (text === '') return;
      const body = text.split(ctx.eol).join(ctx.eol + contIndent); // indent wrapped lines
      if (firstBlock) {
        lines.push(`${indent}${marker}${task}${body}`);
        firstBlock = false;
      } else {
        lines.push(''); // blank line before a loose continuation block
        lines.push(contIndent + body);
      }
    };
    const flushInline = (): void => {
      if (inlineRun.length === 0) return;
      const fake: P5Element = { ...child, childNodes: inlineRun } as P5Element;
      emitLines(writeParagraphLines(fake, ctx));
      inlineRun = [];
    };
    for (const c of child.childNodes ?? []) {
      if (isElement(c) && (c.tagName === 'ul' || c.tagName === 'ol')) {
        flushInline();
        if (firstBlock) {
          lines.push(`${indent}${marker}${task}`.replace(/\s+$/, ''));
          firstBlock = false;
        } else if (loose) {
          lines.push(''); // keep a loose item loose across its nested list
        }
        lines.push(...writeListItems(c, ctx, contIndent)); // already contIndent-ed
      } else if (isElement(c) && c.tagName === 'p') {
        flushInline();
        emitLines(writeParagraphLines({ ...c } as P5Element, ctx));
      } else if (isElement(c) && LIST_BLOCK_TAGS.has(c.tagName)) {
        // A block child (code fence, quote, table, hr, heading, island): write
        // it as a real block, not flattened to text.
        flushInline();
        emitLines(writeBlockElement(c, ctx));
      } else {
        inlineRun.push(c);
      }
    }
    flushInline();
    if (firstBlock) lines.push(`${indent}${marker}${task}`.replace(/\s+$/, '')); // empty item
  }
  return lines;
}

function writeFence(el: P5Element, ctx: Ctx): string {
  const codeEl = (el.childNodes ?? []).find((c) => isElement(c) && c.tagName === 'code') as
    | P5Element
    | undefined;
  const content = textContentBr(codeEl ?? el, '\n').replace(/\n$/, '');
  const langClass = codeEl ? (attr(codeEl, 'class') ?? '') : '';
  const lang = /language-([a-zA-Z0-9#+_.-]{1,32})/.exec(langClass)?.[1] ?? '';
  const base = ctx.flavor.fence;
  const ch = base[0]!;
  const runs = content.match(new RegExp(`\\${ch}{3,}`, 'g')) ?? [];
  const fenceLen = Math.max(3, runs.reduce((m, r) => Math.max(m, r.length), 0) + 1);
  const fence = ch.repeat(fenceLen);
  const body = content.split('\n').join(ctx.eol);
  return `${fence}${lang}${ctx.eol}${body}${ctx.eol}${fence}`;
}

function writeTable(el: P5Element, ctx: Ctx): string {
  const rows: P5Element[] = [];
  const collect = (n: P5Node): void => {
    if (!isElement(n)) return;
    if (n.tagName === 'tr') rows.push(n);
    else for (const c of n.childNodes ?? []) collect(c);
  };
  for (const c of el.childNodes ?? []) collect(c);
  if (rows.length === 0) return '';
  const cellCtx: Ctx = { ...ctx, inTable: true };
  const rowText = (row: P5Element): { cells: string[]; aligns: string[] } => {
    const cells: string[] = [];
    const aligns: string[] = [];
    for (const c of row.childNodes ?? []) {
      if (!isElement(c) || (c.tagName !== 'td' && c.tagName !== 'th')) continue;
      const fake: P5Element = { ...c } as P5Element;
      cells.push(writeParagraphLines(fake, cellCtx).split(cellCtx.eol).join(' ') || ' ');
      aligns.push(hasClass(c, 'al-c') ? ':---:' : hasClass(c, 'al-r') ? '---:' : '---');
    }
    return { cells, aligns };
  };
  const head = rowText(rows[0]!);
  const lines = [`| ${head.cells.join(' | ')} |`, `| ${head.aligns.join(' | ')} |`];
  for (const row of rows.slice(1)) {
    const r = rowText(row);
    lines.push(`| ${r.cells.join(' | ')} |`);
  }
  return lines.join(ctx.eol);
}

function writeBlockElement(el: P5Element, ctx: Ctx): string {
  const tag = el.tagName;
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    let text = writeInlineChildren(el, ctx).split(ctx.eol).join(' ');
    // A trailing " #" run would be read as an ATX CLOSING sequence on re-parse,
    // silently dropping it — escape it so the heading keeps its literal text.
    text = text.replace(/(\s)(#+)(\s*)$/, (_m, ws, hashes, sp) => `${ws}\\${hashes}${sp}`);
    return `${'#'.repeat(level)} ${text}`;
  }
  switch (tag) {
    case 'p':
      return writeParagraphLines(el, ctx);
    case 'hr':
      return ctx.flavor.hr;
    case 'ul':
    case 'ol':
      return writeListItems(el, ctx, '').join(ctx.eol);
    case 'blockquote': {
      const inner = writeBlocks(el.childNodes ?? [], ctx);
      return inner
        .split(ctx.eol)
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join(ctx.eol);
    }
    case 'pre':
      if (hasClass(el, 'md-math')) {
        const content = textContent(el).replace(/\n$/, '');
        return `$$${ctx.eol}${content.split('\n').join(ctx.eol)}${ctx.eol}$$`;
      }
      return writeFence(el, ctx);
    case 'table':
      return writeTable(el, ctx);
    case 'details':
    case 'div':
      if (tag === 'div' && hasClass(el, 'md-footnote')) {
        const label = (el.childNodes ?? []).find(
          (c) => isElement(c) && hasClass(c as P5Element, 'md-footnote-label'),
        );
        const rest = (el.childNodes ?? []).filter((c) => c !== label);
        const inner = writeBlocks(rest, ctx);
        return `[^${label ? textContent(label) : '?'}]: ${inner.split(ctx.eol).join(`${ctx.eol}    `)}`;
      }
      if (tag === 'div' && attr(el, 'data-redra-island') !== undefined) {
        // OUR island wrapper — it exists only in the derived view; the file
        // gets the island's CONTENT, never the wrapper div itself.
        return (el.childNodes ?? []).map(islandHtml).join('');
      }
      if (tag === 'div') {
        // A BARE div is editing/paste chrome (Chromium splits, VS Code and web
        // clipboards wrap blocks in divs), never our render vocabulary. With
        // BLOCK children each child writes as its own block (a pasted
        // <div><p>a</p><p>b</p></div> must not fuse to "ab"); a pure inline
        // run writes as one paragraph. Raw HTML never enters the file here.
        const hasBlockChild = (el.childNodes ?? []).some(
          (c) => isElement(c) && (BLOCKY_TAGS.has(c.tagName) || /^h[1-6]$/.test(c.tagName)),
        );
        if (hasBlockChild) return writeBlocks(el.childNodes ?? [], ctx);
        return writeParagraphLines(el, ctx);
      }
      // Islands rooted directly (details) : HTML verbatim minus stamps.
      return islandHtml(el);
    case 'img':
      return writeInlineNode(el, ctx);
    default:
      // Not a known block: try inline write (covers stray inline roots),
      // fall back to plain text.
      return writeInlineNode(el, ctx) || escapeInline(textContent(el), false);
  }
}

function writeBlocks(nodes: P5Node[], ctx: Ctx): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (isText(node)) {
      const trimmed = node.value.trim();
      if (trimmed !== '')
        parts.push(escapeLineStart(escapeInline(trimmed, ctx.inTable)));
      continue;
    }
    if (!isElement(node)) continue;
    const written = writeBlockElement(node, ctx);
    if (written !== '') parts.push(written);
  }
  return parts.join(ctx.eol + ctx.eol);
}

/**
 * Write ONE live (edited) block back to Markdown. `el` is the block's root
 * element in the save-time parse5 tree (stamps still on it — ignored here).
 */
export function writeElementMarkdown(el: P5Element, flavor: MdFlavor, eol: string): string {
  return writeBlockElement(el, { flavor, eol, inTable: false });
}

/** Test helper: parse a rendered-block HTML string and write it back. */
export function writeBlockHtmlMarkdown(html: string, flavor: MdFlavor, eol: string): string {
  const fragment = parseFragment(html);
  const roots = (fragment.childNodes ?? []).filter((n) => isElement(n) || (isText(n) && n.value.trim() !== ''));
  return writeBlocks(roots as P5Node[], { flavor, eol, inTable: false });
}
