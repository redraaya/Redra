// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTitlebarTooltips } from '../../src/renderer/titlebar-tooltip';
import type { TipInfo } from '../../src/shared/ipc';

function makeButton(label: string, rect = { left: 1000, width: 30 }): HTMLButtonElement {
  const b = document.createElement('button');
  b.setAttribute('aria-label', label);
  b.getBoundingClientRect = () =>
    ({ left: rect.left, width: rect.width, right: rect.left + rect.width, top: 7, bottom: 37, height: 30, x: rect.left, y: 7, toJSON() {} }) as DOMRect;
  document.body.appendChild(b);
  return b;
}

let docMode = false;
const shown: TipInfo[] = [];
let hideCalls = 0;

function init(btn: HTMLButtonElement): void {
  initTitlebarTooltips([btn], {
    isDocMode: () => docMode,
    showOverDoc: (info) => shown.push(info),
    hideOverDoc: () => {
      hideCalls += 1;
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<header id="titlebar" style="height:44px"></header>';
  // jsdom gives offsetHeight 0; the module falls back to 44, which is correct here.
  docMode = false;
  shown.length = 0;
  hideCalls = 0;
});
afterEach(() => vi.useRealTimers());

describe('titlebar tooltip', () => {
  it('shows over the document after the dwell delay (doc mode)', () => {
    docMode = true;
    const btn = makeButton('Сохранить (⌘S)');
    init(btn);
    btn.dispatchEvent(new Event('mouseenter'));
    expect(shown).toHaveLength(0); // not yet — still within the delay
    vi.advanceTimersByTime(400);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.text).toBe('Сохранить (⌘S)');
    expect(shown[0]!.x).toBe(1015); // left 1000 + width/2
    expect(shown[0]!.y).toBe(48); // 44 strip + 4 gap
    // the local start-screen pill must NOT be used in doc mode
    expect(document.getElementById('tb-tip')!.classList.contains('visible')).toBe(false);
  });

  it('draws the local pill on the start screen', () => {
    docMode = false;
    const btn = makeButton('Открыть… (⌘O)');
    init(btn);
    btn.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(400);
    const pill = document.getElementById('tb-tip')!;
    expect(pill.classList.contains('visible')).toBe(true);
    expect(pill.textContent).toBe('Открыть… (⌘O)');
    expect(shown).toHaveLength(0); // no IPC on the start screen
  });

  it('leaving before the delay shows nothing', () => {
    docMode = true;
    const btn = makeButton('Найти (⌘F)');
    init(btn);
    btn.dispatchEvent(new Event('mouseenter'));
    btn.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(400);
    expect(shown).toHaveLength(0);
  });

  it('leaving after show hides it (doc mode → hideOverDoc)', () => {
    docMode = true;
    const btn = makeButton('Повторить (⇧⌘Z)');
    init(btn);
    btn.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(400);
    expect(shown).toHaveLength(1);
    btn.dispatchEvent(new Event('mouseleave'));
    expect(hideCalls).toBe(1);
  });

  it('a hidden button shows no tooltip', () => {
    docMode = false;
    const btn = makeButton('Сохранить (⌘S)');
    btn.hidden = true;
    init(btn);
    btn.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(400);
    expect(document.getElementById('tb-tip')!.classList.contains('visible')).toBe(false);
  });

  it('mousedown (a click) drops a shown tip', () => {
    docMode = true;
    const btn = makeButton('Экспорт в PDF… (⇧⌘E)');
    init(btn);
    btn.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(400);
    btn.dispatchEvent(new Event('mousedown'));
    expect(hideCalls).toBe(1);
  });
});
