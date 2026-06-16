/**
 * Fast custom tooltips for the titlebar ICON buttons only (open, find, undo,
 * redo, preview, pdf, save, theme). The native `title` tooltip is slow (~1s
 * OS delay) and styled by the OS; these are a small dark pill that appears
 * ~180ms after the pointer settles on a button, just below it.
 *
 * The text comes from each button's `data-tip` (the localized string main.ts
 * already sets) — the native `title` is removed by the caller so there is no
 * double tooltip. Lives INSIDE the renderer; the doc-view handle pill and the
 * B/I/<> toolbar (which live in the doc view's own world) are untouched.
 *
 * The pill is position:fixed and z-indexed above the titlebar; it sits below
 * the 44px strip so it never collides with the buttons themselves.
 */

/** Delay before a settled pointer reveals the tooltip. */
export const TOOLTIP_DELAY_MS = 180;
/** Gap between the button's bottom edge and the pill. */
const TOOLTIP_GAP = 6;

export interface TooltipController {
  /** The shared pill element (one per controller). */
  element: HTMLElement;
  /** Wire a button: its `data-tip` becomes the pill text on hover. */
  attach(button: HTMLElement): void;
  /** Hide immediately (used on click/blur). */
  hide(): void;
  /** Tear down timers and the pill (tests / hot reload). */
  destroy(): void;
}

/**
 * Compute the pill's fixed-position top-left so it sits centered under the
 * button, clamped into the viewport. Pure — unit-testable without layout.
 */
export function tooltipPosition(
  buttonRect: { left: number; right: number; bottom: number },
  pillWidth: number,
  viewportWidth: number,
  gap: number = TOOLTIP_GAP,
): { left: number; top: number } {
  const center = (buttonRect.left + buttonRect.right) / 2;
  let left = Math.round(center - pillWidth / 2);
  const margin = 6;
  left = Math.max(margin, Math.min(left, viewportWidth - pillWidth - margin));
  return { left, top: Math.round(buttonRect.bottom + gap) };
}

export function createTooltip(
  doc: Document,
  delayMs: number = TOOLTIP_DELAY_MS,
): TooltipController {
  const pill = doc.createElement('div');
  pill.id = 'tb-tooltip';
  pill.setAttribute('role', 'tooltip');
  pill.hidden = true;
  doc.body.appendChild(pill);

  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function hide(): void {
    clearTimer();
    pill.hidden = true;
  }

  function reveal(button: HTMLElement): void {
    const text = button.dataset['tip'];
    if (!text) return;
    pill.textContent = text;
    pill.hidden = false;
    // Measure AFTER the text is set and the pill is laid out.
    const rect = button.getBoundingClientRect();
    const view = (doc.defaultView?.innerWidth ?? 0) || doc.documentElement.clientWidth;
    const { left, top } = tooltipPosition(rect, pill.offsetWidth, view);
    pill.style.left = `${left}px`;
    pill.style.top = `${top}px`;
  }

  function attach(button: HTMLElement): void {
    button.addEventListener('mouseenter', () => {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        reveal(button);
      }, delayMs);
    });
    // mouseleave, a click (the action fired — the tooltip is now noise) and
    // losing focus all dismiss it.
    button.addEventListener('mouseleave', hide);
    button.addEventListener('click', hide);
    button.addEventListener('blur', hide);
  }

  // The pill can outlive the pointer when focus leaves the window without a
  // mouseleave — Cmd+Tab away, a programmatic blur, or the tab going hidden.
  // Hide on window blur and on visibilitychange (when hidden) so it never
  // lingers over another app's window.
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') hide();
  };
  const view = doc.defaultView;
  view?.addEventListener('blur', hide);
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    element: pill,
    attach,
    hide,
    destroy(): void {
      hide();
      view?.removeEventListener('blur', hide);
      doc.removeEventListener('visibilitychange', onVisibility);
      pill.remove();
    },
  };
}
