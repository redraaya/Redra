/**
 * mdast → Telegram "classic HTML" parse-mode string (the other clipboard
 * flavor). Telegram Desktop pastes the HTML flavor with live entities. Only
 * the entities Telegram's HTML parser accepts are emitted; everything else is
 * flattened to text. Escaping: & < > in text; " in attributes.
 */
import type { Root as MdastRoot } from 'mdast';

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

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (t: string): string => esc(t).replace(/"/g, '&quot;');

function safeUrl(url: string): string {
  const s = url.trim();
  return /^(https?:|mailto:|tg:|#|\/|\.)/i.test(s) || !/:/.test(s) ? s : '';
}

function inline(nodes: AnyNode[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(node: AnyNode): string {
  switch (node.type) {
    case 'text':
      return esc(node.value ?? '');
    case 'strong':
      return `<b>${inline(node.children)}</b>`;
    case 'emphasis':
      return `<i>${inline(node.children)}</i>`;
    case 'delete':
      return `<s>${inline(node.children)}</s>`;
    case 'tgSpoiler':
      return `<tg-spoiler>${inline(node.children)}</tg-spoiler>`;
    case 'mdMark':
      return inline(node.children);
    case 'inlineCode':
      return `<code>${esc(node.value ?? '')}</code>`;
    case 'inlineMath':
      return esc(node.value ?? '');
    case 'break':
      return '\n';
    case 'link': {
      const url = safeUrl(node.url ?? '');
      const text = inline(node.children) || esc(url);
      return url ? `<a href="${escAttr(url)}">${text}</a>` : text;
    }
    case 'image':
      return esc(node.alt ?? '');
    case 'html': {
      const v = node.value ?? '';
      if (/^<\/?(u|ins)>$/i.test(v)) return v.startsWith('</') ? '</u>' : '<u>';
      if (/^<\/?tg-spoiler>$/i.test(v)) return v;
      return '';
    }
    default:
      return node.children ? inline(node.children) : '';
  }
}

function block(node: AnyNode): string {
  switch (node.type) {
    case 'heading':
      return `<b>${inline(node.children)}</b>`;
    case 'paragraph':
      return inline(node.children);
    case 'blockquote':
      return `<blockquote>${(node.children ?? []).map(block).join('\n')}</blockquote>`;
    case 'list': {
      let n = node.start ?? 1;
      return (node.children ?? [])
        .map((li) => {
          const marker = node.ordered ? `${n++}. ` : '• ';
          return marker + (li.children ?? []).map(block).join('\n');
        })
        .join('\n');
    }
    case 'code': {
      const lang = node.lang && /^[a-zA-Z0-9#+_.-]{1,32}$/.test(node.lang) ? node.lang : '';
      const cls = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${cls}>${esc(node.value ?? '')}</code></pre>`;
    }
    case 'math':
      return esc(node.value ?? '');
    case 'thematicBreak':
      return '—';
    default:
      return node.children ? inline(node.children) : '';
  }
}

export function toTelegramHtml(tree: MdastRoot): string {
  return (tree.children as unknown as AnyNode[])
    .map(block)
    .filter((s) => s.trim() !== '')
    .join('\n\n');
}
