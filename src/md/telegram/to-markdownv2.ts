/**
 * mdast → Telegram MarkdownV2 (Copy for Telegram, Stage 8).
 *
 * Input is the CURRENT document's mdast (source with journal ops applied, then
 * re-parsed — so it reflects edits). MarkdownV2 is a MESSAGE dialect, not a
 * document one: it has no headings/tables, and * means BOLD (not italic). We
 * flatten document structure into what Telegram renders: strong to *bold*,
 * emphasis to _italic_, u to __underline__, delete to ~strike~ (single tilde),
 * spoiler to double-pipe, inline code and fenced pre, links, heading to a bold
 * line, list to bullet/number lines, blockquote to > lines. Every literal run
 * is escaped (escapeV2); nesting stays full-containment.
 */
import type { Root as MdastRoot } from 'mdast';
import { escapeV2, escapeV2Code, escapeV2Url } from './escaper.js';

type AnyNode = {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  lang?: string | null;
  url?: string;
  alt?: string | null;
  children?: AnyNode[];
};

/** Only http/https/mailto/tg destinations reach Telegram. */
function safeUrl(url: string): string {
  const s = url.trim();
  if (/\s/.test(s)) return ''; // a raw space is not a valid destination → drop the link
  return /^(https?:|mailto:|tg:|#|\/|\.)/i.test(s) || !/:/.test(s) ? s : '';
}

function inline(nodes: AnyNode[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(node: AnyNode): string {
  switch (node.type) {
    case 'text':
      return escapeV2(node.value ?? '');
    case 'strong':
      return `*${inline(node.children)}*`;
    case 'emphasis':
      return `_${inline(node.children)}_`;
    case 'delete':
      return `~${inline(node.children)}~`;
    case 'tgSpoiler':
      return `||${inline(node.children)}||`;
    case 'mdMark':
      return inline(node.children); // no MarkdownV2 highlight — keep the text
    case 'inlineCode':
      return `\`${escapeV2Code(node.value ?? '')}\``;
    case 'inlineMath':
      return escapeV2(node.value ?? '');
    case 'break':
      return '\n';
    case 'link': {
      const url = safeUrl(node.url ?? '');
      const text = inline(node.children) || escapeV2(url);
      return url ? `[${text}](${escapeV2Url(url)})` : text;
    }
    case 'image': {
      // Telegram messages have no inline images — emit the alt text.
      return escapeV2(node.alt ?? '');
    }
    case 'html': {
      // <u>/<ins> underline and <tg-spoiler> are the file's Telegram entities.
      const v = node.value ?? '';
      if (/^<\/?(u|ins)>$/i.test(v)) return '__';
      if (/^<tg-spoiler>$/i.test(v) || /^<\/tg-spoiler>$/i.test(v)) return '||';
      return ''; // drop other raw html tags
    }
    default:
      return node.children ? inline(node.children) : '';
  }
}

function block(node: AnyNode, depth: number): string {
  switch (node.type) {
    case 'heading': {
      // MarkdownV2 has no headings → a bold line. An EMPTY heading (e.g. the
      // untitled '# ' starter) must emit nothing, not an empty '**' entity —
      // Telegram rejects empty entities.
      const inner = inline(node.children);
      return inner ? `*${inner}*` : '';
    }
    case 'paragraph':
      return inline(node.children);
    case 'blockquote':
      // Telegram MarkdownV2 quotes are single-level: a second '>' on a line is
      // reserved CONTENT and makes the Bot API reject the whole message. Strip
      // any leading markers a nested blockquote produced, then add our single
      // one — the nesting flattens (Telegram can't render it anyway).
      return (node.children ?? [])
        .map((c) => block(c, depth))
        .join('\n\n')
        .split('\n')
        .map((l) => `>${l.replace(/^>+ ?/, '')}`)
        .join('\n');
    case 'list': {
      let n = node.start ?? 1;
      return (node.children ?? [])
        .map((li) => {
          const marker = node.ordered ? `${n++}\\. ` : '• ';
          const body = (li.children ?? []).map((c) => block(c, depth + 1)).join('\n');
          return marker + body.split('\n').join('\n  ');
        })
        .join('\n');
    }
    case 'code': {
      const lang = node.lang && /^[a-zA-Z0-9#+_.-]{1,32}$/.test(node.lang) ? node.lang : '';
      return `\`\`\`${lang}\n${escapeV2Code(node.value ?? '')}\n\`\`\``;
    }
    case 'math':
      return escapeV2(node.value ?? '');
    case 'table':
      // Telegram has no tables — flatten to one line per row, cells separated by
      // an escaped pipe (a raw '|' is reserved and would be rejected). Without
      // this the default case concatenates every cell into one run-on string.
      return (node.children ?? [])
        .map((row) => (row.children ?? []).map((cell) => inline(cell.children)).join(' \\| '))
        .join('\n');
    case 'thematicBreak':
      return '—';
    case 'html':
      return ''; // raw block html is not a Telegram entity
    case 'definition':
    case 'footnoteDefinition':
      return '';
    default:
      return node.children ? inline(node.children) : '';
  }
}

export function toMarkdownV2(tree: MdastRoot): string {
  return (tree.children as unknown as AnyNode[])
    .map((n) => block(n, 0))
    .filter((s) => s.trim() !== '')
    .join('\n\n');
}
