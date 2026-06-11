import { REDRA_ID_ATTR } from '../../engine/types.js';

/**
 * Floating editor chrome: the block handle pill (⋮⋮ grip + trash), the drag
 * drop-indicator line and the drag ghost.
 *
 * Handle + indicator live inside a CLOSED shadow root on a zero-size fixed
 * host appended to <html> — page CSS cannot restyle them, page scripts
 * cannot reach into the shadow. The ghost is the one exception: it must
 * LOOK like the dragged block, so it is a clone appended OUTSIDE the shadow
 * (page CSS must apply to it); it is inert (pointer-events:none) and its
 * data-redra-id stamps are stripped so no editor logic can ever target it.
 *
 * Visual values follow the approved mockup (design/mockups/redra-concept.html):
 * neutral grays only, no red.
 */

const HANDLE_GAP = 16; // px between pill and block edge (mockup: -46px at 30px width)
const HANDLE_WIDTH = 30;

const SHADOW_CSS = `
:host { all: initial; }
.handle {
  position: fixed;
  width: ${HANDLE_WIDTH}px;
  box-sizing: border-box;
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(28, 27, 25, 0.09);
  box-shadow: 0 3px 10px rgba(20, 18, 14, 0.12);
  color: #8a877f;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  z-index: 1;
}
.handle.visible { display: flex; }
.grip {
  cursor: grab;
  font-size: 13px;
  line-height: 0.6;
  letter-spacing: -1px;
  text-align: center;
  padding: 3px 8px;
  touch-action: none;
}
.trash {
  all: initial;
  display: flex;
  cursor: pointer;
  color: inherit;
  padding: 2px;
}
.grip:hover, .trash:hover { color: #1c1b19; }
.indicator {
  position: fixed;
  display: none;
  height: 2px;
  border-radius: 1px;
  background: rgba(28, 27, 25, 0.35);
  pointer-events: none;
}
.indicator.visible { display: block; }
@media (prefers-color-scheme: dark) {
  .handle {
    background: rgba(35, 34, 32, 0.95);
    border-color: rgba(236, 234, 230, 0.12);
    color: #8f8c84;
  }
  .grip:hover, .trash:hover { color: #eceae6; }
  .indicator { background: rgba(236, 234, 230, 0.4); }
}
`;

const TRASH_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
  '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';

export interface OverlayCallbacks {
  onDelete(): void;
  onGripDown(event: PointerEvent): void;
}

export class Overlay {
  private readonly doc: Document;
  private readonly host: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly indicator: HTMLElement;
  private ghost: HTMLElement | null = null;
  private block: HTMLElement | null = null;

  constructor(doc: Document, callbacks: OverlayCallbacks) {
    this.doc = doc;
    this.host = doc.createElement('div');
    // The host is zero-size and inert; everything visible is inside the
    // shadow (fixed-positioned) or explicitly appended next to it (ghost).
    for (const [prop, value] of [
      ['position', 'fixed'],
      ['left', '0'],
      ['top', '0'],
      ['width', '0'],
      ['height', '0'],
      ['overflow', 'visible'],
      ['z-index', '2147483647'],
    ] as const) {
      this.host.style.setProperty(prop, value, 'important');
    }

    const root = this.host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = SHADOW_CSS;
    root.appendChild(style);

    this.handle = doc.createElement('div');
    this.handle.className = 'handle';
    const grip = doc.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.setAttribute('title', 'Перетащить блок');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      callbacks.onGripDown(e);
    });
    const trash = doc.createElement('button');
    trash.className = 'trash';
    trash.setAttribute('title', 'Удалить блок');
    trash.innerHTML = TRASH_SVG;
    trash.addEventListener('click', () => callbacks.onDelete());
    this.handle.append(grip, trash);
    root.appendChild(this.handle);

    this.indicator = doc.createElement('div');
    this.indicator.className = 'indicator';
    root.appendChild(this.indicator);

    doc.documentElement.appendChild(this.host);
  }

  /** True when the (retargeted) event landed on overlay chrome. */
  containsTarget(target: unknown): boolean {
    if (typeof target !== 'object' || target === null) return false;
    if (typeof (target as Node).nodeType !== 'number') return false;
    return this.host.contains(target as Node);
  }

  get currentBlock(): HTMLElement | null {
    return this.block;
  }

  showHandle(block: HTMLElement): void {
    this.block = block;
    this.handle.classList.add('visible');
    this.reposition();
  }

  hideHandle(): void {
    this.block = null;
    this.handle.classList.remove('visible');
  }

  /** Re-anchor the handle to the current block (scroll/resize, rAF-throttled by the caller). */
  reposition(): void {
    if (!this.block) return;
    if (!this.block.isConnected) {
      this.hideHandle();
      return;
    }
    const rect = this.block.getBoundingClientRect();
    let left = rect.left - HANDLE_WIDTH - HANDLE_GAP;
    if (left < 6) left = rect.left + 6; // block flush to the window edge: tuck inside
    const height = this.handle.offsetHeight || 56;
    let top = rect.top + rect.height / 2 - height / 2;
    const viewportH = this.doc.documentElement.clientHeight;
    top = Math.max(6, Math.min(top, viewportH - height - 6));
    this.handle.style.left = `${left}px`;
    this.handle.style.top = `${top}px`;
  }

  showDropIndicator(left: number, top: number, width: number): void {
    this.indicator.style.left = `${left}px`;
    this.indicator.style.top = `${top - 1}px`;
    this.indicator.style.width = `${width}px`;
    this.indicator.classList.add('visible');
  }

  hideDropIndicator(): void {
    this.indicator.classList.remove('visible');
  }

  /** Translucent clone of the block following the cursor during drag. */
  showGhost(block: HTMLElement, x: number, y: number): void {
    this.hideGhost();
    const rect = block.getBoundingClientRect();
    const ghost = block.cloneNode(true) as HTMLElement;
    ghost.removeAttribute(REDRA_ID_ATTR);
    ghost.querySelectorAll(`[${REDRA_ID_ATTR}]`).forEach((el) => {
      el.removeAttribute(REDRA_ID_ATTR);
    });
    ghost.removeAttribute('id'); // never duplicate page ids in the live DOM
    for (const [prop, value] of [
      ['position', 'fixed'],
      ['width', `${rect.width || 200}px`],
      ['margin', '0'],
      ['opacity', '0.55'],
      ['pointer-events', 'none'],
      ['z-index', '2147483646'],
    ] as const) {
      ghost.style.setProperty(prop, value, 'important');
    }
    this.ghost = ghost;
    this.doc.documentElement.appendChild(ghost);
    this.moveGhost(x, y);
  }

  moveGhost(x: number, y: number): void {
    if (!this.ghost) return;
    this.ghost.style.setProperty('left', `${x + 10}px`, 'important');
    this.ghost.style.setProperty('top', `${y + 8}px`, 'important');
  }

  hideGhost(): void {
    this.ghost?.remove();
    this.ghost = null;
  }

  destroy(): void {
    this.hideGhost();
    this.host.remove();
  }
}
