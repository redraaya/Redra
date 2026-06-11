/**
 * Relative time for the start screen's «Недавние» rows, in Russian.
 * Pure function of two timestamps — no Date.now() inside, so it is fully testable.
 *
 * Branches (per approved spec):
 *   < 1 мин   → «только что»
 *   < 1 ч     → «N мин назад»
 *   < 1 сут   → «N ч назад»
 *   < 2 сут   → «вчера»
 *   < 7 сут   → «N дн назад»
 *   иначе     → дата «DD.MM.YYYY»
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = nowMs - thenMs;
  // Clock skew / future timestamps: treat as «just now».
  if (diff < MINUTE) return 'только что';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} мин назад`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} ч назад`;
  if (diff < 2 * DAY) return 'вчера';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} дн назад`;
  const d = new Date(thenMs);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}
