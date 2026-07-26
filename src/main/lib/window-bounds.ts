/**
 * Window-size restoration (pure logic, Electron-free for tests).
 *
 * The app remembers the last window bounds in settings.json and opens new
 * windows at that size. Saved coordinates are only trusted while they still
 * make sense: displays get unplugged and resolutions change between runs, and
 * a window restored onto a monitor that is gone would be unreachable.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RestoredBounds {
  width: number;
  height: number;
  /** Present only when the saved position is still visibly on some display. */
  x?: number;
  y?: number;
}

/** How much of the titlebar must remain grabbable to trust a saved position. */
const MIN_VISIBLE = 100;

/**
 * Turn saved bounds into safe BrowserWindow options. Size is clamped to the
 * window minimum and the largest available work area; the position survives
 * only when at least a MIN_VISIBLE×MIN_VISIBLE corner of the window's TOP
 * strip intersects a display's work area (else the OS centers the window).
 */
export function restoreBounds(
  saved: Rect | undefined,
  workAreas: readonly Rect[],
  min: { width: number; height: number },
  fallback: { width: number; height: number },
): RestoredBounds {
  if (!saved || workAreas.length === 0) return { ...fallback };

  const maxW = Math.max(...workAreas.map((a) => a.width));
  const maxH = Math.max(...workAreas.map((a) => a.height));
  const width = Math.min(Math.max(saved.width, min.width), maxW);
  const height = Math.min(Math.max(saved.height, min.height), maxH);

  // The strip the user grabs to move the window: its top MIN_VISIBLE pixels.
  const grab: Rect = { x: saved.x, y: saved.y, width: saved.width, height: MIN_VISIBLE };
  const visible = workAreas.some((area) => {
    const w = Math.min(grab.x + grab.width, area.x + area.width) - Math.max(grab.x, area.x);
    const h = Math.min(grab.y + grab.height, area.y + area.height) - Math.max(grab.y, area.y);
    return w >= MIN_VISIBLE && h >= Math.min(MIN_VISIBLE, grab.height);
  });

  return visible ? { width, height, x: saved.x, y: saved.y } : { width, height };
}
