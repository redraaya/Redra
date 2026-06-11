/**
 * Update-availability check: pure logic, no Electron imports.
 *
 * The check is deliberately quiet — any network error, timeout, malformed
 * payload, draft or prerelease yields null and the app stays silent. Offline
 * must be noiseless by construction.
 */

export interface LatestRelease {
  /** Release version without the leading «v», e.g. «0.2.0». */
  version: string;
  /** Release page on github.com — the only place 'update:open' will go. */
  url: string;
}

/** Parse «1.2.3» (optionally «v1.2.3», parts may be missing) into [major, minor, patch]. */
function semverParts(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.');
  const nums = [0, 1, 2].map((i) => {
    const n = Number.parseInt(parts[i] ?? '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

/** Numeric major.minor.patch compare; malformed input counts as 0.0.0. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

/**
 * Pick {version, url} out of the GitHub «latest release» JSON.
 * Null on drafts, prereleases, missing fields, or an html_url that is not
 * an https://github.com/ page — the payload is untrusted input.
 */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  if (r['draft'] === true || r['prerelease'] === true) return null;
  const tag = r['tag_name'];
  const url = r['html_url'];
  if (typeof tag !== 'string' || tag.length === 0) return null;
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
  return { version: tag.replace(/^v/, ''), url };
}

/** Notify only when latest is strictly newer AND the user has not dismissed exactly it. */
export function shouldNotify(
  current: string,
  latest: string,
  dismissedVersion: string | undefined,
): boolean {
  if (compareSemver(latest, current) <= 0) return false;
  return latest !== dismissedVersion;
}

/**
 * Ask the GitHub API for the latest release. 5s hard timeout; any error,
 * non-200 or unusable payload → null. `fetchFn` is injectable for tests.
 */
export async function fetchLatestRelease(
  repo = 'redraaya/Redra',
  fetchFn: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Redra' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseLatestRelease(await res.json());
  } catch {
    return null; // offline / DNS / timeout / bad JSON — all silent
  } finally {
    clearTimeout(timer);
  }
}
