// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNoticeToast, NOTICE_HIDE_MS } from '../../src/renderer/notice.js';

describe('shell notice toast (rejected-op pill)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts hidden; show() reveals the text', () => {
    const toast = createNoticeToast(document);
    expect(toast.element.hidden).toBe(true);

    toast.show('Действие отменено');
    expect(toast.element.hidden).toBe(false);
    expect(toast.element.textContent).toBe('Действие отменено');
  });

  it('auto-hides after the timeout', () => {
    const toast = createNoticeToast(document);
    toast.show('текст');
    vi.advanceTimersByTime(NOTICE_HIDE_MS - 1);
    expect(toast.element.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.element.hidden).toBe(true);
  });

  it('a second show() replaces the text and restarts the timer', () => {
    const toast = createNoticeToast(document);
    toast.show('первый');
    vi.advanceTimersByTime(NOTICE_HIDE_MS - 500);

    toast.show('второй');
    expect(toast.element.textContent).toBe('второй');
    vi.advanceTimersByTime(NOTICE_HIDE_MS - 1);
    expect(toast.element.hidden).toBe(false); // the old timer did not fire
    vi.advanceTimersByTime(1);
    expect(toast.element.hidden).toBe(true);
  });

  it('is a polite live region (role=status), never focus-stealing', () => {
    const toast = createNoticeToast(document);
    expect(toast.element.getAttribute('role')).toBe('status');
  });
});
