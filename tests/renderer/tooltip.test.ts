// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTooltip, tooltipPosition, TOOLTIP_DELAY_MS } from '../../src/renderer/tooltip.js';

describe('tooltipPosition', () => {
  it('centers the pill under the button', () => {
    const { left, top } = tooltipPosition(
      { left: 100, right: 130, bottom: 40 },
      60, // pill width
      1024,
    );
    // center = 115, left = 115 - 30 = 85; top = bottom + gap(6) = 46
    expect(left).toBe(85);
    expect(top).toBe(46);
  });

  it('clamps the pill into the viewport on the right edge', () => {
    const { left } = tooltipPosition({ left: 990, right: 1020, bottom: 40 }, 120, 1024);
    // would overflow; clamp to viewport - width - margin = 1024 - 120 - 6 = 898
    expect(left).toBe(898);
  });

  it('clamps to the left margin when the button hugs the left edge', () => {
    const { left } = tooltipPosition({ left: 4, right: 20, bottom: 40 }, 80, 1024);
    expect(left).toBe(6); // never less than the 6px margin
  });
});

describe('createTooltip (jsdom)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeButton = (tip: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.dataset['tip'] = tip;
    document.body.appendChild(b);
    return b;
  };

  it('mounts hidden and reveals the data-tip text after the delay', () => {
    const tip = createTooltip(document);
    const b = makeButton('Открыть… (⌘O)');
    tip.attach(b);
    expect(tip.element.hidden).toBe(true);

    b.dispatchEvent(new MouseEvent('mouseenter'));
    // not yet — the delay has not elapsed
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    expect(tip.element.hidden).toBe(true);

    vi.advanceTimersByTime(1);
    expect(tip.element.hidden).toBe(false);
    expect(tip.element.textContent).toBe('Открыть… (⌘O)');
  });

  it('mouseleave before the delay cancels the pending show', () => {
    const tip = createTooltip(document);
    const b = makeButton('Сохранить (⌘S)');
    tip.attach(b);

    b.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 50);
    b.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(100);
    expect(tip.element.hidden).toBe(true);
  });

  it('a click on the button hides the tooltip (the action fired)', () => {
    const tip = createTooltip(document);
    const b = makeButton('Просмотр (⌘E)');
    tip.attach(b);
    b.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip.element.hidden).toBe(false);

    b.dispatchEvent(new MouseEvent('click'));
    expect(tip.element.hidden).toBe(true);
  });

  it('hides the pill on window blur (Cmd+Tab / programmatic focus loss)', () => {
    const tip = createTooltip(document);
    const b = makeButton('Найти (⌘F)');
    tip.attach(b);
    b.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip.element.hidden).toBe(false);

    window.dispatchEvent(new Event('blur'));
    expect(tip.element.hidden).toBe(true);
  });

  it('a button without data-tip never shows the pill', () => {
    const tip = createTooltip(document);
    const b = document.createElement('button'); // no data-tip
    document.body.appendChild(b);
    tip.attach(b);
    b.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip.element.hidden).toBe(true);
  });

  it('picks up a button whose data-tip changes after attach (dynamic theme label)', () => {
    const tip = createTooltip(document);
    const b = makeButton('Тема: системная');
    tip.attach(b);
    b.dataset['tip'] = 'Тема: тёмная'; // theme cycled
    b.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(tip.element.textContent).toBe('Тема: тёмная');
  });
});
