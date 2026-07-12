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

function linkDest(url: string): string {
  if (url === '') return '<>';
  if (/[\s()]/.test(url)) return `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
  return url;
}

/** Serialize an island subtree back to HTML, dropping data-redra-* stamps.
 *  Vocabulary is already sanitized, so emitting tags verbatim is safe. */
function islandHtml(node: P5Node): string {
  if (isText(node)) {
    return node.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (!isElement(node)) return '';
  const attrs = node.attrs
    .filter((a) => !a.name.startsWith('data-redra-'))
    .map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');
  const inner = (node.childNodes ?? []).map(islandHtml).join('');
  if (node.tagName === 'br' || node.tagName === 'img' || node.tagName === 'hr') {
    return `<${node.tagName}${attrs}>`;
  }
  return `<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
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
    case 'sup': {
      const inner = writeInlineChildren(node, ctx);
      return inner === '' ? '' : `<${node.tagName}>${inner}</${node.tagName}>`;
    }
    case 'code':
      return hasClass(node, 'md-fnref') ? '' : codeSpan(textContent(node));
    case 'span':
      if (hasClass(node, 'md-math')) return `$${textContent(node)}$`;
      return writeInlineChildren(node, ctx); // plain span: transparent
    case 'a': {
      const href = attr(node, 'href') ?? '';
      const inner = writeInlineChildren(node, ctx);
      if (inner === '' && href === '') return '';
      return `[${inner}](${linkDest(href)})`;
    }
    case 'img': {
      const alt = (attr(node, 'alt') ?? '').replace(/([[\]\\])/g, '\\$1');
      return `![${alt}](${linkDest(attr(node, 'src') ?? '')})`;
    }
    case 'sup':
      return ''; // unreachable (handled above); satisfies exhaustiveness readers
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
      text
        .split(ctx.eol)
        .map((line) => escapeLineStart(line))
        .join(ctx.eol)
        .trim(),
    )
    .filter((p) => p !== '');
  return paragraphs.join(ctx.eol + ctx.eol);
}

function writeListItems(list: P5Element, ctx: Ctx, indent: string): string[] {
  const ordered = list.tagName === 'ol';
  const startAttr = attr(list, 'start');
  let n = startAttr ? Number(startAttr) : 1;
  const lines: string[] = [];
  for (const child of list.childNodes ?? []) {
    if (!isElement(child) || child.tagName !== 'li') continue;
    const marker = ordered ? `${n}. ` : `${ctx.flavor.bullet} `;
    n++;
    const task = hasClass(child, 'md-task')
      ? hasClass(child, 'md-task-done')
        ? '[x] '
        : '[ ] '
      : '';
    const contIndent = indent + ' '.repeat(marker.length);
    const inlineParts: P5Node[] = [];
    const nested: P5Element[] = [];
    for (const c of child.childNodes ?? []) {
      if (isElement(c) && (c.tagName === 'ul' || c.tagName === 'ol')) nested.push(c);
      else inlineParts.push(c);
    }
    const fake: P5Element = { ...child, childNodes: inlineParts } as P5Element;
    const text = writeParagraphLines(fake, ctx) || '';
    const own = `${indent}${marker}${task}${text.split(ctx.eol + ctx.eol).join(ctx.eol + contIndent)}`;
    lines.push(own);
    for (const sub of nested) lines.push(...writeListItems(sub, ctx, contIndent));
  }
  return lines;
}

function writeFence(el: P5Element, ctx: Ctx): string {
  const codeEl = (el.childNodes ?? []).find((c) => isElement(c) && c.tagName === 'code') as
    | P5Element
    | undefined;
  const content = textContent(codeEl ?? el).replace(/\n$/, '');
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
    return `${'#'.repeat(level)} ${writeInlineChildren(el, ctx).split(ctx.eol).join(' ')}`;
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
