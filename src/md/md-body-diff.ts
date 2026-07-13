/**
 * MD 2.0 save core: serialize the .md source from the LIVE document body.
 *
 * The whole-document editing model (the doc view arms <main> as one
 * contenteditable) replaces the per-block op journal for Markdown. On commit
 * the view sends its full body innerHTML; this module diffs it against the
 * OPEN-TIME pristine decomposition block by block:
 *
 *   - a top-level element that still carries its pristine stamp (data-redra-id
 *     "m<i>") AND whose parse5 round-trip equals the pristine block's own
 *     round-trip is UNTOUCHED → its original source slice is emitted verbatim;
 *   - everything else (edited blocks, new paragraphs, Chromium-made splits)
 *     goes through the HTML→MD writer — which stays the security gate: unknown
 *     elements degrade to text, islands are re-sanitized, unsafe URLs blanked.
 *
 * Gap rules mirror the reviewed op-table serializer they replace: the author's
 * own inter-block gap is byte-faithful only between an ORIGINALLY-ADJACENT
 * unchanged pair; any other boundary keeps the gap only when it already
 * contains a blank line, else synthesizes one (a lone '\n' that was valid
 * after a heading would fuse two paragraphs or swallow a link definition).
 *
 * The baseline is never reparsed during the document's life — the diff always
 * runs against the open-time pristine, exactly like the HTML journal
 * accumulates ops since open. A second save of the same body is byte-stable.
 */
import { parseFragment, serializeOuter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { renderBlockHtml, collectDefinitions, escapeHtml } from './md-render.js';
import type { MdDefinition } from './md-render.js';
import { writeElementMarkdown, writeBlockHtmlMarkdown } from './md-writer.js';
import type { MdFlavor } from './md-flavor.js';
import { mdBlockIndexOf } from './md-types.js';
import type { MdDoc } from './md-types.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
const isText = (n: P5Node): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text';

function getId(el: P5Element): string | undefined {
  return el.attrs.find((a) => a.name === 'data-redra-id')?.value;
}

/**
 * Strip VIEW-STATE attributes before comparison. `details.open` is one of the
 * few properties Chromium reflects back into the ATTRIBUTE: merely clicking a
 * disclosure to read it would otherwise fail the pristine equality and push
 * the island through the writer — destroying source attributes the sanitizer
 * stripped from the DOM (they exist only in the pristine bytes).
 */
function stripViewState(node: P5Node): void {
  if (!isElement(node)) return;
  if (node.tagName === 'details') {
    node.attrs = node.attrs.filter((a) => a.name !== 'open');
  }
  for (const c of node.childNodes ?? []) stripViewState(c);
}

/**
 * Canonical comparison form of an HTML string's first element: parse5 parse →
 * serializeOuter. Both sides of the diff go through this exact fixpoint, so
 * source-form differences (entity spellings, attribute quoting) cancel out and
 * only real tree differences remain. View-state attributes are normalized out.
 */
export function roundtripOuter(html: string): string {
  const fragment = parseFragment(html);
  const el = (fragment.childNodes ?? []).find(isElement);
  if (!el) return '';
  stripViewState(el);
  return serializeOuter(el);
}

/** Comparison form of a LIVE parse5 element (already parsed from the body). */
function compareOuter(el: P5Element): string {
  // Round-trip through a string so both sides share the exact same pipeline
  // (stripViewState mutates — never touch the caller's tree in place).
  return roundtripOuter(serializeOuter(el));
}

/** One emitted piece: an untouched pristine block or writer output. */
type Piece = { kind: 'pristine'; idx: number } | { kind: 'written'; text: string };

/**
 * Serialize the .md source for a live body. `bodyHtml` is the <main>
 * innerHTML as reported by the view (untrusted — everything non-pristine is
 * routed through the writer gate). Returns the full file text.
 */
export function serializeMdFromBody(doc: MdDoc, bodyHtml: string, flavor: MdFlavor): string {
  const fragment = parseFragment(bodyHtml);

  // Reference definitions from the WHOLE pristine doc — pristine compare
  // renders must match the served render exactly (renderDocumentBody used the
  // same shared map).
  const defs = new Map<string, MdDefinition>();
  for (const b of doc.blocks) {
    for (const [k, v] of collectDefinitions(b.node as { children?: unknown[] })) defs.set(k, v);
  }

  // Lazy pristine round-trips: only blocks whose id actually appears in the
  // live body pay for a render+parse.
  const compareCache = new Map<number, string>();
  const pristineCompare = (idx: number): string => {
    let c = compareCache.get(idx);
    if (c === undefined) {
      c = roundtripOuter(renderBlockHtml(doc.blocks[idx]!, defs));
      compareCache.set(idx, c);
    }
    return c;
  };

  const seen = new Set<number>();
  const pieces: Piece[] = [];
  for (const node of fragment.childNodes ?? []) {
    if (isText(node)) {
      // Stray top-level text (Chromium sometimes leaves bare text at the
      // root) — write it as a paragraph THROUGH the writer, escaped so raw
      // text can never re-parse as markup.
      if (node.value.trim() === '') continue;
      const text = writeBlockHtmlMarkdown(`<p>${escapeHtml(node.value)}</p>`, flavor, doc.eol);
      if (text.trim() !== '') pieces.push({ kind: 'written', text });
      continue;
    }
    if (!isElement(node)) continue; // comments etc. — never file content

    const id = getId(node);
    const idx = id !== undefined ? mdBlockIndexOf(id) : null;
    if (
      idx !== null &&
      idx >= 0 &&
      idx < doc.blocks.length &&
      !seen.has(idx) && // a duplicated stamp (block pasted twice) is pristine ONCE
      compareOuter(node) === pristineCompare(idx)
    ) {
      seen.add(idx);
      pieces.push({ kind: 'pristine', idx });
      continue;
    }
    const text = writeElementMarkdown(node, flavor, doc.eol);
    // Empty writes (an empty <p><br></p> spacer, an unknown chrome element)
    // add no content — the neighbouring gap already provides the blank line.
    if (text.trim() !== '') pieces.push({ kind: 'written', text });
  }

  // INVISIBLE pristine blocks — reference-link definitions render to no
  // element (md-render 'definition' case), so they can never appear in the
  // live DOM and the loop above never sees them. The user cannot touch them
  // either: they ALWAYS survive verbatim. Anchor each one right after its
  // original predecessor when that predecessor survived untouched (keeping
  // the author's own gap byte-faithful); orphans go to the end of the file.
  const invisible = new Set<number>();
  for (let i = 0; i < doc.blocks.length; i++) {
    if ((doc.blocks[i]!.node as { type?: string }).type === 'definition') invisible.add(i);
  }
  if (invisible.size > 0) {
    const placed = new Set<number>();
    const withInvisible: Piece[] = [];
    const chainFrom = (start: number): void => {
      for (let j = start; invisible.has(j) && !placed.has(j) && !seen.has(j); j++) {
        withInvisible.push({ kind: 'pristine', idx: j });
        placed.add(j);
      }
    };
    chainFrom(0); // definitions at the very head of the file
    for (const piece of pieces) {
      withInvisible.push(piece);
      if (piece.kind === 'pristine') chainFrom(piece.idx + 1);
    }
    for (const idx of [...invisible].sort((a, b) => a - b)) {
      if (!placed.has(idx)) withInvisible.push({ kind: 'pristine', idx });
    }
    pieces.length = 0;
    pieces.push(...withInvisible);
  }

  if (pieces.length === 0) return '';

  const BLANK_LINE = /\r?\n[ \t]*\r?\n/;
  const INDENTED = /^(?: {4,}|\t)/; // indented-code / continuation-capturable slice
  let out = doc.gaps[0]!; // leading whitespace of the file — safe before any block
  let prevIdx: number | null = null;
  let first = true;
  for (const piece of pieces) {
    const currIdx = piece.kind === 'pristine' ? piece.idx : null;
    const adjacent = prevIdx !== null && currIdx !== null && currIdx === prevIdx + 1;
    if (!first) {
      if (adjacent) {
        // Originally-adjacent unchanged pair — the author's own gap holds.
        out += doc.gaps[currIdx!]!;
      } else {
        const candidate = currIdx !== null ? doc.gaps[currIdx]! : '';
        out += BLANK_LINE.test(candidate) ? candidate : doc.eol + doc.eol;
      }
    }
    if (piece.kind === 'pristine') {
      const b = doc.blocks[piece.idx]!;
      const slice = doc.source.slice(b.span.start, b.span.end);
      // An INDENTED slice is only safe after its ORIGINAL predecessor: behind
      // a new neighbour (a list the user just made, a written block) a blank
      // line does NOT stop CommonMark from capturing it as continuation — an
      // untouched indented code block would silently become list content on
      // re-parse. Re-write it through the writer (a fence survives anywhere).
      if (!first && !adjacent && INDENTED.test(slice)) {
        const fragment = parseFragment(renderBlockHtml(b, defs));
        const el = (fragment.childNodes ?? []).find(isElement);
        out += el ? writeElementMarkdown(el, flavor, doc.eol) : slice;
        prevIdx = null; // canonicalized — its successor must re-validate too
        first = false;
        continue;
      }
      out += slice;
      prevIdx = piece.idx;
    } else {
      out += piece.text;
      prevIdx = null;
    }
    first = false;
  }

  const last = pieces[pieces.length - 1]!;
  if (last.kind === 'pristine' && last.idx === doc.blocks.length - 1) {
    out += doc.gaps[doc.blocks.length]!; // the file's own trailing whitespace
  } else {
    out += doc.eol;
  }
  return out;
}
