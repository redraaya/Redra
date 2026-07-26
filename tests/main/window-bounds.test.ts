import { describe, expect, it } from 'vitest';
import { restoreBounds } from '../../src/main/lib/window-bounds.js';

/** Window-size restoration: clamp to reality, trust position only on-screen. */

const MAIN = { x: 0, y: 0, width: 1728, height: 1079 }; // a laptop work area
const SECOND = { x: 1728, y: -200, width: 2560, height: 1415 }; // external, above-right
const MIN = { width: 800, height: 600 };
const FALLBACK = { width: 1100, height: 760 };

describe('restoreBounds', () => {
  it('nothing saved → the default size, no position (OS centers)', () => {
    expect(restoreBounds(undefined, [MAIN], MIN, FALLBACK)).toEqual(FALLBACK);
  });

  it('a saved on-screen window comes back exactly', () => {
    const saved = { x: 200, y: 100, width: 1200, height: 900 };
    expect(restoreBounds(saved, [MAIN], MIN, FALLBACK)).toEqual(saved);
  });

  it('a window from an unplugged display keeps its SIZE but drops the position', () => {
    const saved = { x: 2000, y: 300, width: 1400, height: 1000 }; // was on SECOND
    expect(restoreBounds(saved, [MAIN], MIN, FALLBACK)).toEqual({ width: 1400, height: 1000 });
  });

  it('the position survives on a multi-display layout it belongs to', () => {
    const saved = { x: 2000, y: 300, width: 1400, height: 1000 };
    expect(restoreBounds(saved, [MAIN, SECOND], MIN, FALLBACK)).toEqual(saved);
  });

  it('size is clamped between the window minimum and the largest work area', () => {
    const tiny = { x: 10, y: 10, width: 300, height: 200 };
    expect(restoreBounds(tiny, [MAIN], MIN, FALLBACK)).toMatchObject({ width: 800, height: 600 });
    const huge = { x: 10, y: 10, width: 9000, height: 9000 };
    expect(restoreBounds(huge, [MAIN], MIN, FALLBACK)).toMatchObject({ width: 1728, height: 1079 });
  });

  it('a sliver of visibility is not enough — the grab strip must be reachable', () => {
    // Only 40px of the title strip peeks onto the display → recentre instead.
    const saved = { x: MAIN.width - 40, y: 100, width: 1200, height: 900 };
    const out = restoreBounds(saved, [MAIN], MIN, FALLBACK);
    expect(out.x).toBeUndefined();
    expect(out).toMatchObject({ width: 1200, height: 900 });
  });

  it('a window dragged mostly ABOVE the work area recentres too', () => {
    const saved = { x: 300, y: -880, width: 1200, height: 900 }; // title strip off-screen
    const out = restoreBounds(saved, [MAIN], MIN, FALLBACK);
    expect(out.x).toBeUndefined();
  });

  it('no displays reported → fallback (never throws)', () => {
    expect(restoreBounds({ x: 0, y: 0, width: 1200, height: 900 }, [], MIN, FALLBACK)).toEqual(
      FALLBACK,
    );
  });
});
