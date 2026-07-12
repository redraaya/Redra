/**
 * Markdown document model (v0.5, Stage 1).
 *
 * The same philosophy as the HTML RedraDoc, adapted to a DERIVED view:
 * the .md source is decomposed into alternating GAPS (inter-block raw
 * slices: blank lines, stray whitespace) and top-level BLOCKS (mdast
 * children with exact source offsets). The invariant
 *
 *     gaps[0] + block[0] + gaps[1] + block[1] + … + gaps[n] === source
 *
 * is what makes byte-faithful saving possible: ops touch block entries,
 * untouched blocks and ALL gaps are emitted verbatim (see md-ops, Stage 2).
 *
 * Ids follow the clone-id pattern already proven in the engine
 * ("c7"/"c7-4", cloneRootOf): block roots are "m<blockIndex>", stamped
 * descendants "m<i>-<n>" in deterministic pre-order render order — so the
 * op-guard prefix rule and the save-time materialization agree on ids by
 * construction.
 */
import type { Root as MdastRoot, RootContent } from 'mdast';

/** Half-open span [start, end) of code-unit offsets into MdDoc.source. */
export interface MdSpan {
  start: number;
  end: number;
}

/** One top-level block: the mdast node + its exact source span. */
export interface MdBlockEntry {
  /** "m<index>" — the id stamped on the block's rendered root element. */
  rootId: string;
  span: MdSpan;
  node: RootContent;
}

export interface MdDoc {
  /** The original text, BOM already stripped by decode — never mutated. */
  readonly source: string;
  /** Pristine mdast tree (with the spoiler/mark inline passes applied). */
  readonly tree: MdastRoot;
  /** Top-level blocks in document order; blocks[i].rootId === `m${i}`. */
  readonly blocks: readonly MdBlockEntry[];
  /** blocks.length + 1 verbatim inter-block slices (may be ''). */
  readonly gaps: readonly string[];
  /** Dominant line ending — the writer emits new lines in this style. */
  readonly eol: '\n' | '\r\n';
}

/** "m3-7" → "m3"; "m3" → "m3"; not an md id → null. */
export function mdRootOf(id: string): string | null {
  const match = /^(m\d+)(?:-\d+)?$/.exec(id);
  return match ? match[1]! : null;
}

/** Block index for an md id ("m3-7" → 3), or null. */
export function mdBlockIndexOf(id: string): number | null {
  const root = mdRootOf(id);
  return root === null ? null : Number(root.slice(1));
}
