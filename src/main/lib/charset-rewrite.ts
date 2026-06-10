/**
 * Charset declaration surgery for edited saves of non-UTF8 files.
 *
 * TextEncoder can only produce utf-8, so a file opened as windows-1251 (or
 * utf-16*) is re-encoded to utf-8 when saved with edits. Its <meta charset>
 * would then lie about the bytes — this module rewrites the declaration with
 * plain string surgery (no reparse: everything outside the affected meta tag
 * stays byte-for-byte, in line with the verbatim philosophy).
 *
 * Choices, documented:
 * - The WHOLE string is scanned, not just the first 1024 chars browsers sniff.
 *   A declaration past the sniff limit is malformed anyway; rewriting it is
 *   cheaper than arguing, and a stale "windows-1251" must not survive.
 * - A document with no charset declaration and no <head> is returned
 *   unchanged: there is no safe insertion point without reparsing, and
 *   browsers' default decoding is locale-dependent — a known limitation.
 * - Pure module: no Electron, no Node APIs.
 */

/** Meta tags (attribute values with a literal `>` inside would break this — not a realistic shape for charset metas). */
const META_TAG_RE = /<meta(?=[\s/>])[^>]*>/gi;

/** Attribute scanner for the inside of a tag: name, optional =value (quoted or bare). */
const ATTR_RE = /([^\s"'<>/=]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'<>/]*))?/g;

interface Attr {
  name: string;
  /** Unquoted value ('' when the attribute has no value). */
  value: string;
  /** Span of `name[=value]` within the tag string. */
  start: number;
  end: number;
  /** Span of the value (inside quotes, if any) within the tag string. */
  valueStart: number;
  valueEnd: number;
}

function scanAttrs(tag: string): Attr[] {
  // Skip "<meta" so the tag name is not treated as an attribute.
  const bodyStart = 5;
  const body = tag.slice(bodyStart, tag.length - 1);
  const attrs: Attr[] = [];
  ATTR_RE.lastIndex = 0;
  for (const m of body.matchAll(ATTR_RE)) {
    if (m[0] === '') continue;
    const name = m[1]!;
    const raw = m[2] ?? '';
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    const value = quoted ? raw.slice(1, -1) : raw;
    const start = bodyStart + m.index;
    const end = start + m[0].length;
    const valueEnd = end - (quoted ? 1 : 0);
    attrs.push({ name: name.toLowerCase(), value, start, end, valueStart: valueEnd - value.length, valueEnd });
  }
  return attrs;
}

const UTF8_META = '<meta charset="utf-8">';

/**
 * Rewrite (or insert) the charset declaration of serialized HTML to utf-8.
 * Call ONLY when the saved bytes are utf-8 but the file was decoded from
 * another encoding. Idempotent.
 */
export function ensureUtf8Charset(html: string): string {
  let found = false;

  const rewritten = html.replace(META_TAG_RE, (tag) => {
    const attrs = scanAttrs(tag);

    // <meta charset=...> form: replace the whole name=value span.
    const charsetAttr = attrs.find((a) => a.name === 'charset');
    if (charsetAttr) {
      found = true;
      return tag.slice(0, charsetAttr.start) + 'charset="utf-8"' + tag.slice(charsetAttr.end);
    }

    // <meta http-equiv="content-type" content="text/html; charset=..."> form:
    // rewrite only the charset part inside the content value.
    const httpEquiv = attrs.find((a) => a.name === 'http-equiv');
    const content = attrs.find((a) => a.name === 'content');
    if (
      httpEquiv &&
      /^content-type$/i.test(httpEquiv.value.trim()) &&
      content &&
      /charset\s*=/i.test(content.value)
    ) {
      found = true;
      const newValue = content.value.replace(/charset\s*=\s*[^;]*/i, 'charset=utf-8');
      return tag.slice(0, content.valueStart) + newValue + tag.slice(content.valueEnd);
    }

    return tag;
  });

  if (found) return rewritten;

  // No declaration anywhere: insert right after the opening <head...> tag.
  const headMatch = /<head(?=[\s/>])[^>]*>|<head>/i.exec(html);
  if (!headMatch) return html; // no <head> → leave unchanged (documented limitation)
  const at = headMatch.index + headMatch[0].length;
  return html.slice(0, at) + UTF8_META + html.slice(at);
}
