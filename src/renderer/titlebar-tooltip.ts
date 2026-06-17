import type { TipInfo } from '../shared/ipc';

/**
 * Custom titlebar tooltips. The native `title` tooltip never appears here: the
 * buttons live inside the window-drag region (`-webkit-app-region: drag`),
 * which suppresses Chromium's tooltip controller — so it shows nothing, on the
 * start screen too, no matter how long you wait. We draw our own instead.
 *
 * Hover detection always happens here (the buttons are in the shell). Where the
 * pill is PAINTED depends on the state, because the document view composites on
 * top of everything below the 44px strip:
 *   • start screen  → a plain DOM pill in this renderer (nothing covers it);
 *   • document open → handed to the doc view over IPC, which paints it in its
 *                     own overlay layer so it clears the strip.
 * Either way the pill sits just below the icon, centred on it.
 *
 * The tip text is read from each button's `aria-label` (already localized and
 * kept in sync, including the dynamic theme button) — no second source to drift.
 */

/** Hover dwell before the tip shows. Fast, but not so eager it flickers. */
const SHOW_DELAY_MS = 380;
/** Gap below the 44px strip so the pill clears it (and the doc view). */
const BELOW_STRIP_GAP = 4;

export interface TitlebarTooltipDeps {
  /** True when a document is open (the doc view owns everything below y=44). */
  isDocMode: () => boolean;
  /** Paint over the document (doc mode). */
  showOverDoc: (info: TipInfo) => void;
  hideOverDoc: () => void;
}

export function initTitlebarTooltips(buttons: HTMLElement[], deps: TitlebarTooltipDeps): void {
  // Local pill for the start screen. Hidden on the doc path (the doc view draws
  // its own); kept in the DOM so re-entering the start screen needs no setup.
  const pill = document.createElement('div');
  pill.id = 'tb-tip';
  pill.setAttribute('aria-hidden', 'true'); // aria-label on the buttons is the a11y name
  document.body.appendChild(pill);

  let timer: number | undefined;
  let shownOverDoc = false;

  const stripBottom = (): number => {
    // offsetHeight is 0 before layout (and in jsdom) — fall back to the known
    // 44px strip so the pill never lands at the top edge.
    const h = document.getElementById('titlebar')?.offsetHeight;
    return (h && h > 0 ? h : 44) + BELOW_STRIP_GAP;
  };

  const hide = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pill.classList.remove('visible');
    if (shownOverDoc) {
      deps.hideOverDoc();
      shownOverDoc = false;
    }
  };

  const show = (btn: HTMLElement): void => {
    const text = btn.getAttribute('aria-label')?.trim();
    if (!text || btn.hidden) return;
    const r = btn.getBoundingClientRect();
    if (r.width === 0) return; // not laid out / hidden
    const x = r.left + r.width / 2;
    const y = stripBottom();
    if (deps.isDocMode()) {
      deps.showOverDoc({ text, x, y });
      shownOverDoc = true;
      return;
    }
    pill.textContent = text;
    pill.classList.add('visible');
    const half = pill.offsetWidth / 2;
    const vw = document.documentElement.clientWidth;
    pill.style.left = `${Math.max(half + 6, Math.min(x, vw - half - 6))}px`;
    pill.style.top = `${y}px`;
  };

  for (const btn of buttons) {
    btn.addEventListener('mouseenter', () => {
      hide();
      timer = window.setTimeout(() => {
        timer = undefined;
        show(btn);
      }, SHOW_DELAY_MS);
    });
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('mousedown', hide); // a click acts — drop the hint
  }
  // Leaving the window (or it losing focus) must not strand a visible pill.
  window.addEventListener('blur', hide);
}
