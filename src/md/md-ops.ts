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
import { mdRootOf } from './md-types.js';
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
  /** Stable identity: the block's root stamp ("m<i>" or a clone "c<n>"). Ops
   *  resolve to their entry by this, NOT by table position — a clone/move
   *  splice must not make a later op edit the wrong block (id-stability). */
  rootId: string;
  /** Original pristine block index this entry materializes from (-1 = clone,
   *  which materializes by parsing its own `pristine` bytes). */
  blockIndex: number;
  /** Present until the block is materialized; then its bytes come from the tree. */
  pristine: string | null;
  /** Parsed fragment whose single root element carries the block's stamps. */
  live: P5Element | null;
  removed: boolean;
  /** The gap that PRECEDED this entry at its ORIGINAL position. Gaps are
   *  emitted POSITIONALLY at serialize time (not carried across a move), so
   *  this is only consulted for entries that never left their run. */
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

function materialize(entry: Entry, doc: MdDoc): P5Element {
  if (entry.live) return entry.live;
  // A pristine top-level block re-renders from its source (ids match the live
  // DOM by the render id-invariant); a clone entry has no doc block, so it
  // parses its own bytes instead.
  const html =
    entry.blockIndex >= 0 ? renderBlockHtml(doc.blocks[entry.blockIndex]!) : (entry.pristine ?? '');
  const fragment = parseFragment(html);
  const root = (fragment.childNodes ?? []).find(isElement);
  if (!root) throw new MdOpError(`block ${entry.rootId} did not materialize`);
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
    rootId: b.rootId,
    blockIndex: i,
    pristine: doc.source.slice(b.span.start, b.span.end),
    live: null,
    removed: false,
    gapBefore: doc.gaps[i]!,
  }));
  const trailingGap = doc.gaps[doc.blocks.length]!;

  /** Resolve an op's id to its entry's CURRENT table index BY IDENTITY — never
   *  by the id-derived position, which drifts after a clone/move splice. */
  const resolveIndex = (id: string): number => {
    const root = mdRootOf(id);
    if (root === null) throw new MdOpError(`op targets a non-md id: ${id}`);
    const idx = table.findIndex((e) => !e.removed && e.rootId === root);
    if (idx < 0) throw new MdOpError(`op targets unknown/removed block: ${id}`);
    return idx;
  };

  for (const op of ops) {
    switch (op.type) {
      case 'editText': {
        const idx = resolveIndex(op.id);
        const root = materialize(table[idx]!, doc);
        const target = getId(root) === op.id ? root : findById(root as unknown as P5Parent, op.id);
        if (!target) throw new MdOpError(`editText: id not in its block: ${op.id}`);
        applyEditText(target, op.html);
        break;
      }
      case 'deleteBlock': {
        const idx = resolveIndex(op.id);
        if (op.id === table[idx]!.rootId) {
          // Top-level: drop the whole entry (bytes leave with it).
          table[idx]!.removed = true;
        } else {
          const root = materialize(table[idx]!, doc);
          const target = findById(root as unknown as P5Parent, op.id);
          if (!target) throw new MdOpError(`deleteBlock: id not in its block: ${op.id}`);
          detach(target);
        }
        break;
      }
      case 'moveBlock': {
        const idx = resolveIndex(op.id);
        if (op.id === table[idx]!.rootId) {
          // Top-level reorder: splice the entry. Gaps are positional (fixed up
          // at serialize time), so the entry travels WITHOUT its gapBefore.
          const beforeIdx = op.beforeId === null ? table.length : resolveIndex(op.beforeId);
          moveEntry(table, idx, beforeIdx);
        } else {
          const root = materialize(table[idx]!, doc);
          moveNested(root as unknown as P5Parent, op.id, op.beforeId);
        }
        break;
      }
      case 'cloneBlock': {
        const idx = resolveIndex(op.id);
        // Top-level clone: duplicate the block as a new entry right after the
        // original. Its rootId is the minted cloneId; it materializes from its
        // own bytes (blockIndex -1). The positional gap rule gives it a real
        // separator at serialize time.
        const entry = table[idx]!;
        const bytes = entry.pristine ?? writeElementMarkdown(entry.live!, RICH_DEFAULTS, doc.eol);
        table.splice(idx + 1, 0, {
          rootId: op.cloneId,
          blockIndex: -1,
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

  // Stash the head + trailing gaps on a sentinel so serialize can find them.
  (table as unknown as { trailingGap: string; headGap: string }).trailingGap = trailingGap;
  (table as unknown as { headGap: string }).headGap = doc.gaps[0]!;
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
  const { trailingGap, headGap } = table as unknown as { trailingGap: string; headGap: string };
  let out = '';
  let first = true;
  for (const entry of table) {
    if (entry.removed) continue;
    // Gaps are POSITIONAL, not owned by the block: the first surviving entry
    // emits the document head (gaps[0]); every later entry emits its original
    // separator when it still HAS one (contains a newline → an unmoved run,
    // kept byte-faithful), else a synthesized blank line (it came from the head
    // and needs a real separator now — the fix for glued/leaked-gap moves).
    if (first) {
      out += headGap;
    } else {
      out += /\n/.test(entry.gapBefore) ? entry.gapBefore : doc.eol + doc.eol;
    }
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
