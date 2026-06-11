import { REDRA_ID_ATTR } from '../../engine/types.js';
import type { Overlay } from './overlay.js';

/**
 * Manual pointer-based drag-reorder among siblings of the SAME parent (A2).
 * No HTML5 drag-and-drop: pointermove drives a ghost + drop indicator,
 * pointerup performs the DOM move and reports it, Escape cancels.
 */

export interface DropInfo {
  block: HTMLElement;
  /** Live-DOM insertion reference (parent.insertBefore(block, beforeEl)). */
  beforeEl: Element | null;
  /** Stable id for the moveBlock op: next stamped sibling at/after beforeEl. */
  beforeId: string | null;
}

export interface DragDeps {
  win: Window;
  overlay: Overlay;
  onDrop(info: DropInfo): void;
  /** Called after the drag ends for any reason (drop or cancel). */
  onEnd(): void;
}

interface Gap {
  /** Insert before this element; null = append to the end of the parent. */
  beforeEl: Element | null;
  y: number;
}

/** Movement (px) before a grip press becomes a drag. */
const DRAG_THRESHOLD = 3;

export function startDrag(block: HTMLElement, start: PointerEvent, deps: DragDeps): void {
  const { win, overlay } = deps;
  const doc = block.ownerDocument;
  const parent = block.parentElement;
  if (!parent) {
    deps.onEnd();
    return;
  }

  const siblings = Array.from(parent.children).filter((el) => el !== block);
  let started = false;
  let currentGap: Gap | null = null;

  const computeGaps = (): Gap[] => {
    const gaps: Gap[] = [];
    for (const sib of siblings) {
      gaps.push({ beforeEl: sib, y: sib.getBoundingClientRect().top });
    }
    const last = siblings[siblings.length - 1];
    if (last) gaps.push({ beforeEl: null, y: last.getBoundingClientRect().bottom });
    return gaps;
  };

  const onMove = (e: PointerEvent): void => {
    if (!started) {
      if (
        Math.abs(e.clientX - start.clientX) < DRAG_THRESHOLD &&
        Math.abs(e.clientY - start.clientY) < DRAG_THRESHOLD
      ) {
        return;
      }
      started = true;
      doc.documentElement.classList.add('redra-dragging');
      overlay.hideHandle();
      overlay.showGhost(block, e.clientX, e.clientY);
    }
    overlay.moveGhost(e.clientX, e.clientY);

    const gaps = computeGaps();
    if (gaps.length === 0) return;
    let best = gaps[0]!;
    for (const gap of gaps) {
      if (Math.abs(gap.y - e.clientY) < Math.abs(best.y - e.clientY)) best = gap;
    }
    currentGap = best;
    const parentRect = parent.getBoundingClientRect();
    overlay.showDropIndicator(parentRect.left, best.y, parentRect.width);
  };

  const finish = (drop: boolean): void => {
    win.removeEventListener('pointermove', onMove, true);
    win.removeEventListener('pointerup', onUp, true);
    win.removeEventListener('keydown', onKey, true);
    doc.documentElement.classList.remove('redra-dragging');
    overlay.hideGhost();
    overlay.hideDropIndicator();

    if (drop && started && currentGap) {
      const { beforeEl } = currentGap;
      // Inserting before our own next sibling (or the equivalent end-gap)
      // leaves the block where it is — not a move, no op.
      const noMove =
        beforeEl === block.nextElementSibling ||
        (beforeEl === null && block.nextElementSibling === null);
      if (!noMove) {
        deps.onDrop({ block, beforeEl, beforeId: stampedIdAtOrAfter(beforeEl) });
      }
    }
    deps.onEnd();
  };

  const onUp = (): void => finish(true);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finish(false);
  };

  win.addEventListener('pointermove', onMove, true);
  win.addEventListener('pointerup', onUp, true);
  win.addEventListener('keydown', onKey, true);
}

/**
 * The engine's moveBlock(beforeId) must reference a STAMPED sibling.
 * Script-created (unstamped) elements at the drop point are skipped forward;
 * dropping past them lands the block before the next source element.
 */
function stampedIdAtOrAfter(el: Element | null): string | null {
  for (let e: Element | null = el; e; e = e.nextElementSibling) {
    const id = e.getAttribute(REDRA_ID_ATTR);
    if (id) return id;
  }
  return null;
}
