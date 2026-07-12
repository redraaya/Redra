/**
 * MD save = block-table splicing (Stage 2 core, plan risk R1/R2).
 *
 * serializeMdSource mirrors the HTML engine's applyOps, but instead of
 * mutating a parse5 tree and re-serializing the WHOLE document, it works on
 * a table of top-level entries — each either a PRISTINE source slice
 * (emitted byte-for-byte) or a LIVE parse5 fragment (an edited block,
 * emitted through the HTML→MD writer). Untouched blocks and ALL inter-block
 * gaps travel verbatim, so unedited bytes are preserved exactly. Zero ops
 * returns doc.source verbatim (identical shortcut to the HTML path).
 *
 * A nested-id op (e.g. editText on a <li> "m3-2") materializes the block by
 * re-rendering its pristine slice — ids match the live DOM by the render
 * id-invariant — then applies the change in HTML space. Ops resolve by id,
 * never by table position, so a block that renders to nothing (a reference
 * definition keeps its m-index but no DOM element) still rides along as an
 * untouchable verbatim slice.
 */
import { parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { Op } from '../engine/ops.js';
import { renderBlockHtml } from './md-render.js';
import { writeElementMarkdown } from './md-writer.js';
import type { MdFlavor } from './md-flavor.js';
import { RICH_DEFAULTS } from './md-flavor.js';
import { mdBlockIndexOf, mdRootOf } from './md-types.js';
import type { MdDoc } from './md-types.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
function getId(el: P5Element): string | undefined {
  return el.attrs.find((a) => a.name === 'data-redra-id')?.value;
}

export class MdOpError extends Error {}

/** One entry in the working block table. */
interface Entry {
  /** Present until the block is materialized; then its bytes come from the tree. */
  pristine: string | null;
  /** Parsed fragment whose single root element carries the block's stamps. */
  live: P5Element | null;
  removed: boolean;
  /** The gap that PRECEDES this entry (gaps[i]); the trailing gap is separate. */
  gapBefore: string;
}

function findById(root: P5Parent, id: string): P5Element | null {
  const stack: P5Node[] = [...(root.childNodes ?? [])];
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    if (getId(node) === id) return node;
    for (const c of node.childNodes ?? []) stack.push(c);
  }
  return null;
}

function materialize(entry: Entry, blockIndex: number, doc: MdDoc): P5Element {
  if (entry.live) return entry.live;
  const html = renderBlockHtml(doc.blocks[blockIndex]!);
  const fragment = parseFragment(html);
  const root = (fragment.childNodes ?? []).find(isElement);
  if (!root) throw new MdOpError(`block m${blockIndex} did not materialize`);
  entry.live = root as P5Element;
  entry.pristine = null;
  return entry.live;
}

/** Replace element.children with the parsed op.html (mirrors HTML editText). */
function applyEditText(el: P5Element, html: string): void {
  const fragment = parseFragment(html);
  const children = fragment.childNodes ?? [];
  for (const c of children) (c as { parentNode: P5Parent }).parentNode = el as unknown as P5Parent;
  el.childNodes = children;
}

/**
 * Apply ops to a working block table built from the pristine MdDoc.
 * `dryRun` skips writer serialization — the op-guard uses it to prove an op
 * sequence applies before accepting a push (mirrors tryApplyOps).
 */
export function applyMdOps(doc: MdDoc, ops: readonly Op[]): Entry[] {
  const table: Entry[] = doc.blocks.map((b, i) => ({
    pristine: doc.source.slice(b.span.start, b.span.end),
    live: null,
    removed: false,
    gapBefore: doc.gaps[i]!,
  }));
  const trailingGap = doc.gaps[doc.blocks.length]!;
  // Clone minting continues the HTML "c<n>" namespace (disjoint from m<n>).
  let cloneCounter = 0;

  const rootIndex = (id: string): number => {
    const idx = mdBlockIndexOf(id);
    if (idx === null || idx < 0 || idx >= table.length || table[idx]!.removed) {
      throw new MdOpError(`op targets unknown/removed block: ${id}`);
    }
    return idx;
  };

  for (const op of ops) {
    switch (op.type) {
      case 'editText': {
        const idx = rootIndex(op.id);
        const root = materialize(table[idx]!, idx, doc);
        const target = getId(root) === op.id ? root : findById(root as unknown as P5Parent, op.id);
        if (!target) throw new MdOpError(`editText: id not in its block: ${op.id}`);
        applyEditText(target, op.html);
        break;
      }
      case 'deleteBlock': {
        const idx = rootIndex(op.id);
        const rootId = mdRootOf(op.id);
        if (op.id === rootId) {
          // Top-level: drop the whole entry (bytes leave with it).
          table[idx]!.removed = true;
        } else {
          const root = materialize(table[idx]!, idx, doc);
          const target = findById(root as unknown as P5Parent, op.id);
          if (!target) throw new MdOpError(`deleteBlock: id not in its block: ${op.id}`);
          detach(target);
        }
        break;
      }
      case 'moveBlock': {
        // v1: only nested (within-block) moves are exercised by the editing
        // layer for MD (block reorder among top-level blocks arrives here too
        // and is handled by splicing the entry). Top-level move:
        const idx = rootIndex(op.id);
        const rootId = mdRootOf(op.id);
        if (op.id === rootId) {
          const beforeIdx = op.beforeId === null ? table.length : rootIndex(op.beforeId);
          moveEntry(table, idx, beforeIdx);
        } else {
          const root = materialize(table[idx]!, idx, doc);
          moveNested(root as unknown as P5Parent, op.id, op.beforeId);
        }
        break;
      }
      case 'cloneBlock': {
        const idx = rootIndex(op.id);
        cloneCounter++;
        // Top-level clone: duplicate the pristine slice as a new entry right
        // after the original, separated by a blank-line gap.
        const entry = table[idx]!;
        const bytes =
          entry.pristine ?? writeElementMarkdown(entry.live!, RICH_DEFAULTS, doc.eol);
        table.splice(idx + 1, 0, {
          pristine: bytes,
          live: null,
          removed: false,
          gapBefore: doc.eol + doc.eol,
        });
        break;
      }
      case 'setAttr':
        throw new MdOpError('setAttr is not supported for Markdown documents');
    }
  }

  // Stash the trailing gap on a sentinel so serialize can find it.
  (table as unknown as { trailingGap: string }).trailingGap = trailingGap;
  return table;
}

function detach(el: P5Element): void {
  const parent = el.parentNode as P5Parent | null;
  if (!parent) return;
  parent.childNodes = (parent.childNodes ?? []).filter((c) => c !== el);
}

function moveEntry(table: Entry[], from: number, before: number): void {
  const [entry] = table.splice(from, 1);
  const target = before > from ? before - 1 : before;
  table.splice(target, 0, entry!);
}

function moveNested(root: P5Parent, id: string, beforeId: string | null): void {
  const el = findById(root, id);
  if (!el) throw new MdOpError(`moveBlock: id not in its block: ${id}`);
  const parent = el.parentNode as P5Parent | null;
  if (!parent) return;
  const siblings = parent.childNodes ?? [];
  const without = siblings.filter((c) => c !== el);
  const before = beforeId === null ? null : findById(root, beforeId);
  const at = before ? without.indexOf(before) : without.length;
  without.splice(at < 0 ? without.length : at, 0, el);
  parent.childNodes = without;
}

/**
 * Serialize the working table back to a .md source string. Pristine entries
 * emit their slice verbatim; live entries run through the writer.
 */
export function serializeMdSource(doc: MdDoc, ops: readonly Op[], flavor: MdFlavor): string {
  if (ops.length === 0) return doc.source; // byte-identical shortcut
  const table = applyMdOps(doc, ops);
  const trailingGap = (table as unknown as { trailingGap: string }).trailingGap;
  let out = '';
  let first = true;
  for (const entry of table) {
    if (entry.removed) continue;
    // The first surviving entry keeps its gapBefore (document head); a
    // removed leading entry's gap is dropped with it (its bytes are gone).
    out += first ? entry.gapBefore : entry.gapBefore;
    first = false;
    if (entry.live) {
      out += writeElementMarkdown(entry.live, flavor, doc.eol);
    } else {
      out += entry.pristine ?? '';
    }
  }
  out += trailingGap;
  return out;
}

/** Guard dry-run: does this op sequence apply cleanly? (No writer pass.) */
export function tryApplyMdOps(doc: MdDoc, ops: readonly Op[]): { ok: true } | { ok: false; error: string } {
  try {
    applyMdOps(doc, ops);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
