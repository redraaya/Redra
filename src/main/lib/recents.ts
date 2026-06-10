/** Pure recents-list logic: dedupe, most-recent-first, capped. */

export const MAX_RECENTS = 10;

export function addRecent(
  list: readonly string[],
  filePath: string,
  max: number = MAX_RECENTS,
): string[] {
  const next = [filePath, ...list.filter((p) => p !== filePath)];
  return next.slice(0, max);
}

/** Validate parsed JSON from the recents file into a clean string list. */
export function sanitizeRecents(value: unknown, max: number = MAX_RECENTS): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}
