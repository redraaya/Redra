/**
 * .md source → MdDoc: pristine mdast + the gap/block decomposition that
 * carries the byte-fidelity guarantee (see md-types).
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { applyInlinePasses } from './md-inline.js';
import type { MdBlockEntry, MdDoc } from './md-types.js';

/** Dominant line ending; a tie or no line breaks defaults to '\n'. */
export function detectEol(source: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      if (source[i - 1] === '\r') crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

export function parseMarkdownDoc(source: string): MdDoc {
  const tree = fromMarkdown(source, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  applyInlinePasses(tree, source);

  const blocks: MdBlockEntry[] = [];
  const gaps: string[] = [];
  let cursor = 0;
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // Top-level mdast nodes always carry positions; if one ever did not,
    // treating it as part of the surrounding gap keeps the decomposition
    // identity (its bytes stay in the gap slice and remain untouchable).
    if (start === undefined || end === undefined || start < cursor) continue;
    gaps.push(source.slice(cursor, start));
    blocks.push({ rootId: `m${blocks.length}`, span: { start, end }, node });
    cursor = end;
  }
  gaps.push(source.slice(cursor));

  return { source, tree, blocks, gaps, eol: detectEol(source) };
}

/** The identity the whole save strategy rests on — exported for tests and
 *  asserted cheaply at parse time in dev builds. */
export function decompositionIsExact(doc: MdDoc): boolean {
  let rebuilt = '';
  for (let i = 0; i < doc.blocks.length; i++) {
    rebuilt += doc.gaps[i]! + doc.source.slice(doc.blocks[i]!.span.start, doc.blocks[i]!.span.end);
  }
  rebuilt += doc.gaps[doc.blocks.length]!;
  return rebuilt === doc.source;
}
