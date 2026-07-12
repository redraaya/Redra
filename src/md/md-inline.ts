/**
 * Inline passes over the pristine mdast: Telegram-Rich entities that
 * micromark has no syntax for — spoiler ||…|| and highlight ==…==.
 *
 * Escapes are honored by reading the RAW SOURCE at each text node's span:
 * "\|\|not a spoiler\|\|" must stay literal. micromark has already
 * processed backslash escapes into the node VALUE, so raw and value are
 * walked in LOCKSTEP to map raw marker offsets onto value offsets. If the
 * walk desyncs (e.g. a character reference like &amp; changed lengths),
 * the pass conservatively SKIPS that node — markers there stay literal
 * text rather than risking a wrong split. Documented limitation; a proper
 * micromark extension is the phase-2 upgrade.
 */
import type { Root as MdastRoot } from 'mdast';

export interface TgSpoilerNode {
  type: 'tgSpoiler';
  children: Array<{ type: 'text'; value: string }>;
}
export interface MdMarkNode {
  type: 'mdMark';
  children: Array<{ type: 'text'; value: string }>;
}

interface MarkerHit {
  kind: 'spoiler' | 'mark';
  /** Offset in the node VALUE where the 2-char marker starts. */
  valueIndex: number;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/**
 * Walk raw and value together; collect unescaped "||" / "==" marker
 * positions expressed as VALUE offsets. Returns null on desync.
 */
function findMarkers(raw: string, value: string): MarkerHit[] | null {
  const hits: MarkerHit[] = [];
  let i = 0; // raw index
  let j = 0; // value index
  while (i < raw.length) {
    const rc = raw[i]!;
    // Backslash escape: 2 raw chars -> 1 value char (the punctuation).
    if (rc === '\\' && i + 1 < raw.length && ASCII_PUNCT.test(raw[i + 1]!)) {
      if (value[j] !== raw[i + 1]) return null;
      i += 2;
      j += 1;
      continue;
    }
    // CRLF in raw is a single '\n' in the value.
    if (rc === '\r' && raw[i + 1] === '\n') {
      if (value[j] !== '\n') return null;
      i += 2;
      j += 1;
      continue;
    }
    if (rc === '|' && raw[i + 1] === '|') {
      if (value[j] !== '|' || value[j + 1] !== '|') return null;
      hits.push({ kind: 'spoiler', valueIndex: j });
      i += 2;
      j += 2;
      continue;
    }
    if (rc === '=' && raw[i + 1] === '=') {
      if (value[j] !== '=' || value[j + 1] !== '=') return null;
      hits.push({ kind: 'mark', valueIndex: j });
      i += 2;
      j += 2;
      continue;
    }
    if (rc !== value[j]) return null; // entity or unknown transform — bail out
    i += 1;
    j += 1;
  }
  return j === value.length ? hits : null;
}

/** Pair same-kind markers left-to-right; drop pairs with empty content or
 *  pairs overlapping an earlier accepted pair. */
function pairMarkers(hits: MarkerHit[]): Array<{ kind: 'spoiler' | 'mark'; from: number; to: number }> {
  const pairs: Array<{ kind: 'spoiler' | 'mark'; from: number; to: number }> = [];
  for (const kind of ['spoiler', 'mark'] as const) {
    const ofKind = hits.filter((h) => h.kind === kind);
    for (let k = 0; k + 1 < ofKind.length; k += 2) {
      const from = ofKind[k]!.valueIndex;
      const to = ofKind[k + 1]!.valueIndex;
      if (to - from <= 2) continue; // ||…|| with empty content stays literal
      pairs.push({ kind, from, to });
    }
  }
  pairs.sort((a, b) => a.from - b.from);
  const accepted: typeof pairs = [];
  let lastEnd = -1;
  for (const p of pairs) {
    if (p.from < lastEnd) continue; // overlap — earlier pair wins
    accepted.push(p);
    lastEnd = p.to + 2;
  }
  return accepted;
}

/** Split one text node's value into text/spoiler/mark pieces. */
function splitValue(
  value: string,
  pairs: Array<{ kind: 'spoiler' | 'mark'; from: number; to: number }>,
): unknown[] {
  const out: unknown[] = [];
  let cursor = 0;
  for (const p of pairs) {
    if (p.from > cursor) out.push({ type: 'text', value: value.slice(cursor, p.from) });
    const inner = value.slice(p.from + 2, p.to);
    out.push(
      p.kind === 'spoiler'
        ? ({ type: 'tgSpoiler', children: [{ type: 'text', value: inner }] } as TgSpoilerNode)
        : ({ type: 'mdMark', children: [{ type: 'text', value: inner }] } as MdMarkNode),
    );
    cursor = p.to + 2;
  }
  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) });
  return out;
}

const SKIP_PARENTS = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html']);

/**
 * Apply the spoiler/mark passes in place. Only text nodes WITH a position
 * are considered (synthetic nodes have no raw to verify against).
 */
export function applyInlinePasses(tree: MdastRoot, source: string): void {
  const visit = (node: { type: string; children?: unknown[] }): void => {
    if (!node.children || SKIP_PARENTS.has(node.type)) return;
    const next: unknown[] = [];
    let changed = false;
    for (const child of node.children as Array<{
      type: string;
      value?: string;
      children?: unknown[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    }>) {
      if (
        child.type === 'text' &&
        typeof child.value === 'string' &&
        child.position?.start.offset !== undefined &&
        child.position.end.offset !== undefined &&
        (child.value.includes('||') || child.value.includes('=='))
      ) {
        const raw = source.slice(child.position.start.offset, child.position.end.offset);
        const hits = findMarkers(raw, child.value);
        const pairs = hits ? pairMarkers(hits) : [];
        if (pairs.length > 0) {
          next.push(...splitValue(child.value, pairs));
          changed = true;
          continue;
        }
      }
      visit(child as { type: string; children?: unknown[] });
      next.push(child);
    }
    if (changed) node.children = next;
  };
  visit(tree as unknown as { type: string; children?: unknown[] });
}
