/**
 * The RTF clipboard flavor, hand-written for NAIVE parsers.
 *
 * Field round 3 evidence: Telegram's composer DID take the RTF flavor (the
 * link pasted live) but dropped bold/italic/headings — because textutil
 * encodes emphasis as font SWITCHES (Times-Bold in the font table), and a
 * simple parser only honours the explicit attribute flags. So this generator
 * speaks the lowest common denominator: real \b \i \ul \strike toggles,
 * \fs steps for headings, "• / 1. / ☑" line prefixes for lists, an indented
 * paragraph for quotes, a mono font for code, and HYPERLINK fields for
 * links. Every capable reader (TextEdit, Pages, Mail) understands the same
 * primitives, so nothing is lost for them either.
 *
 * Input is the scrubbed clipboard HTML (to-clipboard-html) — a bounded
 * vocabulary, which keeps this writer small and predictable.
 */
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
const isText = (n: P5Node): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text';

function attr(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

/** RTF text escape: control chars + non-ASCII as \uN unicode escapes. */
function esc(text: string): string {
  let out = '';
  for (const ch of text.replace(/\r?\n/g, ' ')) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (code < 128) out += ch;
    else if (code < 32768) out += `\\u${code} `;
    else out += `\\u${code - 65536} `; // RTF \u is a signed 16-bit value
  }
  return out;
}

function inline(nodes: P5Node[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(node: P5Node): string {
  if (isText(node)) return esc(node.value);
  if (!isElement(node)) return '';
  switch (node.tagName) {
    case 'strong':
    case 'b':
      return `{\\b ${inline(node.childNodes)}}`;
    case 'em':
    case 'i':
      return `{\\i ${inline(node.childNodes)}}`;
    case 'u':
    case 'ins':
      return `{\\ul ${inline(node.childNodes)}}`;
    case 's':
    case 'del':
    case 'strike':
      return `{\\strike ${inline(node.childNodes)}}`;
    case 'code':
      return `{\\f1 ${inline(node.childNodes)}}`;
    case 'mark':
    case 'span':
    case 'sub':
    case 'sup':
      return inline(node.childNodes);
    case 'a': {
      const href = attr(node, 'href') ?? '';
      const text = inline(node.childNodes);
      if (href === '') return text;
      return `{\\field{\\*\\fldinst{HYPERLINK "${esc(href)}"}}{\\fldrslt ${text}}}`;
    }
    case 'br':
      return '\\line ';
    case 'img':
      return esc(attr(node, 'alt') ?? '');
    default:
      return inline(node.childNodes);
  }
}

const PARA = '\\pard\\sa200 ';

function block(node: P5Element): string {
  const tag = node.tagName;
  if (/^h[1-6]$/.test(tag)) {
    const size = [40, 34, 30, 26, 24, 24][Number(tag[1]) - 1]!;
    return `${PARA}{\\b\\fs${size} ${inline(node.childNodes)}}\\par\n`;
  }
  switch (tag) {
    case 'p':
      return `${PARA}${inline(node.childNodes)}\\par\n`;
    case 'ul':
    case 'ol': {
      let n = 1;
      const startAttr = attr(node, 'start');
      if (tag === 'ol' && startAttr && /^\d{1,6}$/.test(startAttr)) n = Number(startAttr);
      let out = '';
      for (const li of node.childNodes ?? []) {
        if (!isElement(li) || li.tagName !== 'li') continue;
        // A task item already carries its ☑/☐ glyph as leading text.
        const body = inline(li.childNodes).trimStart();
        const glyphed = /^\\u(9745|9744) /.test(body);
        const marker = glyphed ? '' : tag === 'ol' ? `${n}. ` : '\\bullet  ';
        n += 1;
        out += `\\pard\\li360\\sa80 ${marker}${body}\\par\n`;
      }
      return out;
    }
    case 'blockquote': {
      const inner = (node.childNodes ?? [])
        .filter(isElement)
        .map((c) => inline(c.childNodes))
        .join('\\line ');
      return `\\pard\\li480\\sa200 {\\i ${inner}}\\par\n`;
    }
    case 'pre': {
      const text = collectText(node).replace(/\n$/, '');
      const lines = text.split('\n').map(esc).join('\\line ');
      return `${PARA}{\\f1\\fs24 ${lines}}\\par\n`;
    }
    case 'table': {
      let out = '';
      for (const section of node.childNodes ?? []) {
        const rows = isElement(section) && section.tagName === 'tr' ? [section] : (isElement(section) ? section.childNodes ?? [] : []);
        for (const row of rows) {
          if (!isElement(row) || row.tagName !== 'tr') continue;
          const cells = (row.childNodes ?? [])
            .filter((c): c is P5Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'))
            .map((c) => inline(c.childNodes));
          out += `${PARA}${cells.join('  |  ')}\\par\n`;
        }
      }
      return out;
    }
    case 'hr':
      return `${PARA}\\emdash\\emdash\\emdash\\par\n`;
    default:
      return `${PARA}${inline(node.childNodes)}\\par\n`;
  }
}

function collectText(node: P5Node): string {
  if (isText(node)) return node.value;
  if (!isElement(node)) return '';
  if (node.tagName === 'br') return '\n';
  return (node.childNodes ?? []).map(collectText).join('');
}

/** Scrubbed clipboard HTML → an RTF document naive parsers understand. */
export function toClipboardRtf(clipboardHtml: string): string {
  const fragment = parseFragment(clipboardHtml);
  const body = (fragment.childNodes ?? []).filter(isElement).map(block).join('');
  return (
    '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}{\\f1\\fmodern Menlo;}}\\uc0\n' +
    '\\fs28\n' +
    body +
    '}'
  );
}
