/** Pure settings logic: defaults, validation of stored JSON, partial merge. */

import type { Settings } from '../../shared/ipc.js';

export const DEFAULT_SETTINGS: Settings = {
  shellTheme: 'system',
  backupOnFirstSave: true,
};

const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);

/** Validate parsed JSON from settings.json; anything malformed falls back to defaults. */
export function sanitizeSettings(value: unknown): Settings {
  return mergeSettings(DEFAULT_SETTINGS, value);
}

/**
 * Apply a partial patch onto current settings. Unknown keys and wrongly-typed
 * values are ignored — IPC input is untrusted by construction.
 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const next: Settings = { ...current };
  if (typeof patch !== 'object' || patch === null) return next;
  const p = patch as Record<string, unknown>;
  if (typeof p['shellTheme'] === 'string' && THEMES.has(p['shellTheme'])) {
    next.shellTheme = p['shellTheme'] as Settings['shellTheme'];
  }
  if (typeof p['backupOnFirstSave'] === 'boolean') {
    next.backupOnFirstSave = p['backupOnFirstSave'];
  }
  if (typeof p['dismissedUpdateVersion'] === 'string') {
    next.dismissedUpdateVersion = p['dismissedUpdateVersion'];
  }
  const wb = p['windowBounds'] as Record<string, unknown> | undefined;
  if (
    typeof wb === 'object' &&
    wb !== null &&
    ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((wb as Record<string, unknown>)[k]))
  ) {
    next.windowBounds = {
      x: Math.round(wb['x'] as number),
      y: Math.round(wb['y'] as number),
      width: Math.round(wb['width'] as number),
      height: Math.round(wb['height'] as number),
    };
  }
  if (typeof p['windowMaximized'] === 'boolean') {
    next.windowMaximized = p['windowMaximized'];
  }
  return next;
}
