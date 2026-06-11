import type { Lang } from './i18n.js';

/**
 * Relative time for the start screen's recents rows, RU or EN.
 * Pure function of two timestamps — no Date.now() inside, so it is fully testable.
 *
 * Branches (per approved spec):
 *   < 1 min   → «только что» / "just now"
 *   < 1 h     → «N мин назад» / "N min ago"
 *   < 1 day   → «N ч назад» / "N h ago"
 *   < 2 days  → «вчера» / "yesterday"
 *   < 7 days  → «N дн назад» / "N d ago"
 *   else      → numeric date «DD.MM.YYYY» (same in both languages)
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WORDS = {
  ru: { justNow: 'только что', min: 'мин назад', hour: 'ч назад', yesterday: 'вчера', day: 'дн назад' },
  en: { justNow: 'just now', min: 'min ago', hour: 'h ago', yesterday: 'yesterday', day: 'd ago' },
} as const;

export function formatRelativeTime(thenMs: number, nowMs: number, lang: Lang = 'ru'): string {
  const w = WORDS[lang];
  const diff = nowMs - thenMs;
  // Clock skew / future timestamps: treat as «just now».
  if (diff < MINUTE) return w.justNow;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} ${w.min}`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} ${w.hour}`;
  if (diff < 2 * DAY) return w.yesterday;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} ${w.day}`;
  const d = new Date(thenMs);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}
