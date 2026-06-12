/**
 * Transient quiet toast for the shell strip — currently the rejected-op
 * notice ('notice:show' from main). Non-blocking by design: a pill that
 * appears, sits for a few seconds and goes away; no buttons, no focus.
 *
 * It lives INSIDE the 44px titlebar strip (see #notice-toast in style.css):
 * everything below the strip is covered by the document WebContentsView,
 * which composites ABOVE this renderer — a bottom-of-window toast would
 * simply be invisible while a document is open, i.e. exactly when rejected
 * ops happen.
 */

/** How long the toast stays up. */
export const NOTICE_HIDE_MS = 4000;

export interface NoticeToast {
  element: HTMLElement;
  show(text: string): void;
}

export function createNoticeToast(doc: Document, hideMs: number = NOTICE_HIDE_MS): NoticeToast {
  const el = doc.createElement('div');
  el.id = 'notice-toast';
  el.setAttribute('role', 'status'); // polite live region for screen readers
  el.hidden = true;
  doc.body.appendChild(el);

  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    element: el,
    show(text: string): void {
      el.textContent = text;
      el.title = text; // a long message ellipsizes in the strip — keep it readable
      el.hidden = false;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        el.hidden = true;
        timer = null;
      }, hideMs);
    },
  };
}
