import { REDRA_ID_ATTR } from '../../engine/types.js';
import { makeT, pickLang } from '../../shared/i18n.js';
import { SelectionToolbar, TOOLBAR_CSS } from './toolbar.js';
import type { ToolbarAction } from './toolbar.js';

/**
 * Floating editor chrome: the block handle pill (⋮⋮ grip + duplicate +
 * trash), the drag drop-indicator line and the drag ghost.
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
/** How far left of a block's rect the hover zone must extend to cover the pill. */
export const HANDLE_REACH = HANDLE_WIDTH + HANDLE_GAP;

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
.dup, .trash {
  all: initial;
  display: flex;
  cursor: pointer;
  color: inherit;
  padding: 2px;
}
.grip:hover, .dup:hover, .trash:hover { color: #1c1b19; }
.indicator {
  position: fixed;
  display: none;
  height: 2px;
  border-radius: 1px;
  background: rgba(28, 27, 25, 0.35);
  pointer-events: none;
}
.indicator.visible { display: block; }
.img-chip {
  all: initial;
  position: fixed;
  display: none;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(28, 27, 25, 0.09);
  box-shadow: 0 3px 10px rgba(20, 18, 14, 0.12);
  color: #8a877f;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
}
.img-chip.visible { display: flex; }
.img-chip:hover { color: #1c1b19; }
/* Titlebar tooltip, drawn HERE (not in the shell) so it clears the doc view:
   the shell strip's native tooltips are dead (the window-drag region kills
   them), and a shell-DOM tooltip below y=44 is composited behind this view.
   The shell drives hover detection and feeds text + position over IPC. */
.tb-tip {
  position: fixed;
  display: none;
  max-width: 280px;
  padding: 3px 9px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(28, 27, 25, 0.09);
  box-shadow: 0 3px 10px rgba(20, 18, 14, 0.14);
  color: #1c1b19;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
}
.tb-tip.visible { display: block; }
@media (prefers-color-scheme: dark) {
  .handle {
    background: rgba(35, 34, 32, 0.95);
    border-color: rgba(236, 234, 230, 0.12);
    color: #8f8c84;
  }
  .grip:hover, .dup:hover, .trash:hover { color: #eceae6; }
  .indicator { background: rgba(236, 234, 230, 0.4); }
  .img-chip {
    background: rgba(35, 34, 32, 0.95);
    border-color: rgba(236, 234, 230, 0.12);
    color: #8f8c84;
  }
  .img-chip:hover { color: #eceae6; }
  .tb-tip {
    background: rgba(35, 34, 32, 0.97);
    border-color: rgba(236, 234, 230, 0.12);
    color: #eceae6;
  }
}
/* printToPDF renders print styles — editor chrome must never reach a PDF.
   (The drag ghost lives OUTSIDE the shadow and cannot exist during export:
   exportPdf commits the edit session first and no drag survives that.) */
@media print {
  .handle, .indicator, .img-chip, .tb-tip { display: none !important; }
}
`;

const IMAGE_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
  '<circle cx="8.5" cy="8.5" r="1.5"/>' +
  '<path d="M21 15l-5-5L5 21"/></svg>';

const COPY_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const TRASH_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
  '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';

export interface OverlayCallbacks {
  onDelete(): void;
  /** Click on the duplicate button (the hovered block is currentBlock). */
  onDuplicate(): void;
  onGripDown(event: PointerEvent): void;
  /** Click on the image-replace chip (the hovered <img> is currentImage). */
  onImageReplace(): void;
  /** Inline-formatting toolbar button pressed (value = link href). */
  onToolbar(action: ToolbarAction, value?: string): void;
}

export class Overlay {
  private readonly doc: Document;
  private readonly host: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly imgChip: HTMLElement;
  /** Titlebar tooltip — positioned/filled by the shell over IPC (see showTip). */
  private readonly tip: HTMLElement;
  /** Inline-formatting toolbar (Feature 3) — shown/hidden by the controller. */
  readonly toolbar: SelectionToolbar;
  private ghost: HTMLElement | null = null;
  private block: HTMLElement | null = null;
  private image: HTMLElement | null = null;

  constructor(doc: Document, callbacks: OverlayCallbacks) {
    // The isolated world shares navigator.language with the page — both come
    // from the system locale, which is exactly the auto-language contract.
    const t = makeT(pickLang(navigator.language));
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
    style.textContent = SHADOW_CSS + TOOLBAR_CSS;
    root.appendChild(style);

    this.toolbar = new SelectionToolbar(doc, root, t, (action, value) =>
      callbacks.onToolbar(action, value),
    );

    this.handle = doc.createElement('div');
    this.handle.className = 'handle';
    const grip = doc.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.setAttribute('title', t('overlay.drag'));
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      callbacks.onGripDown(e);
    });
    const dup = doc.createElement('button');
    dup.className = 'dup';
    dup.setAttribute('title', t('overlay.duplicate'));
    dup.innerHTML = COPY_SVG;
    dup.addEventListener('click', () => callbacks.onDuplicate());
    const trash = doc.createElement('button');
    trash.className = 'trash';
    trash.setAttribute('title', t('overlay.delete'));
    trash.innerHTML = TRASH_SVG;
    trash.addEventListener('click', () => callbacks.onDelete());
    this.handle.append(grip, dup, trash);
    root.appendChild(this.handle);

    this.indicator = doc.createElement('div');
    this.indicator.className = 'indicator';
    root.appendChild(this.indicator);

    // Image-replace chip: quiet neutral button at the hovered img's top-right.
    this.imgChip = doc.createElement('button');
    this.imgChip.className = 'img-chip';
    this.imgChip.setAttribute('title', t('overlay.replaceImage'));
    this.imgChip.innerHTML = IMAGE_SVG;
    this.imgChip.addEventListener('click', () => callbacks.onImageReplace());
    root.appendChild(this.imgChip);

    this.tip = doc.createElement('div');
    this.tip.className = 'tb-tip';
    this.tip.setAttribute('aria-hidden', 'true');
    root.appendChild(this.tip);

    doc.documentElement.appendChild(this.host);
  }

  /**
   * Show the titlebar tooltip at (x, y) in THIS view's coordinates (the shell
   * already converted from window to doc-view space). x is the icon's centre;
   * the pill is centred on it (translateX -50%) and clamped to stay on-screen.
   */
  showTip(text: string, x: number, y: number): void {
    this.tip.textContent = text;
    this.tip.classList.add('visible');
    const half = this.tip.offsetWidth / 2;
    const vw = this.doc.documentElement.clientWidth;
    const cx = Math.max(half + 6, Math.min(x, vw - half - 6));
    this.tip.style.left = `${cx}px`;
    this.tip.style.top = `${y}px`;
  }

  hideTip(): void {
    this.tip.classList.remove('visible');
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

  get currentImage(): HTMLElement | null {
    return this.image;
  }

  showImageChip(img: HTMLElement): void {
    this.image = img;
    this.imgChip.classList.add('visible');
    this.repositionImageChip();
  }

  hideImageChip(): void {
    this.image = null;
    this.imgChip.classList.remove('visible');
  }

  /** Anchor the chip INSIDE the img's top-right corner (it overlaps the image). */
  private repositionImageChip(): void {
    if (!this.image) return;
    if (!this.image.isConnected) {
      this.hideImageChip();
      return;
    }
    const rect = this.image.getBoundingClientRect();
    const chip = 26;
    const left = Math.max(rect.left + 4, rect.right - chip - 6);
    const top = Math.max(6, rect.top + 6);
    this.imgChip.style.left = `${left}px`;
    this.imgChip.style.top = `${top}px`;
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

  /** Re-anchor the floating chrome (scroll/resize, rAF-throttled by the caller). */
  reposition(): void {
    this.repositionImageChip();
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
    // Never duplicate page ids in the live DOM — the root AND every
    // descendant (page CSS/scripts may target #ids anywhere in the subtree).
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
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
