import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  fetchLatestRelease,
  parseLatestRelease,
  shouldNotify,
} from '../../src/main/lib/update-check.js';
import { mergeSettings, sanitizeSettings } from '../../src/main/lib/settings.js';

describe('compareSemver', () => {
  it('equal versions → 0', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('patch difference', () => {
    expect(compareSemver('0.1.0', '0.1.1')).toBe(-1);
    expect(compareSemver('0.1.2', '0.1.1')).toBe(1);
  });

  it('minor difference', () => {
    expect(compareSemver('0.1.9', '0.2.0')).toBe(-1);
    expect(compareSemver('0.3.0', '0.2.9')).toBe(1);
  });

  it('major difference', () => {
    expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('numeric, not lexicographic: 0.10.0 > 0.9.9', () => {
    expect(compareSemver('0.10.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.9.9', '0.10.0')).toBe(-1);
  });

  it('tolerates a leading v on either side', () => {
    expect(compareSemver('v0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.2.0', 'v0.1.0')).toBe(1);
    expect(compareSemver('v0.1.0', 'v0.2.0')).toBe(-1);
  });

  it('missing parts count as 0', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.1')).toBe(-1);
  });

  it('malformed input is treated as 0.0.0', () => {
    expect(compareSemver('garbage', '0.0.0')).toBe(0);
    expect(compareSemver('garbage', '0.0.1')).toBe(-1);
    expect(compareSemver('0.1.0', '')).toBe(1);
    expect(compareSemver('1.x.3', '1.0.3')).toBe(0); // bad part → 0
  });
});

describe('parseLatestRelease', () => {
  const valid = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/redraaya/Redra/releases/tag/v0.2.0',
    draft: false,
    prerelease: false,
  };

  it('valid release → version without v + url', () => {
    expect(parseLatestRelease(valid)).toEqual({
      version: '0.2.0',
      url: 'https://github.com/redraaya/Redra/releases/tag/v0.2.0',
    });
  });

  it('tag without v prefix is kept as-is', () => {
    expect(parseLatestRelease({ ...valid, tag_name: '0.3.1' })?.version).toBe('0.3.1');
  });

  it('draft → null', () => {
    expect(parseLatestRelease({ ...valid, draft: true })).toBeNull();
  });

  it('prerelease → null', () => {
    expect(parseLatestRelease({ ...valid, prerelease: true })).toBeNull();
  });

  it('missing tag_name → null', () => {
    const { tag_name: _omit, ...rest } = valid;
    expect(parseLatestRelease(rest)).toBeNull();
    expect(parseLatestRelease({ ...valid, tag_name: 42 })).toBeNull();
  });

  it('missing html_url → null', () => {
    const { html_url: _omit, ...rest } = valid;
    expect(parseLatestRelease(rest)).toBeNull();
  });

  it('http (not https) url → null', () => {
    expect(
      parseLatestRelease({ ...valid, html_url: 'http://github.com/redraaya/Redra/releases' }),
    ).toBeNull();
  });

  it('non-github url → null', () => {
    expect(
      parseLatestRelease({ ...valid, html_url: 'https://evil.example.com/redraaya/Redra' }),
    ).toBeNull();
    expect(
      parseLatestRelease({ ...valid, html_url: 'https://github.com.evil.com/x' }),
    ).toBeNull();
  });

  it('non-object json → null', () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('v0.2.0')).toBeNull();
    expect(parseLatestRelease([valid])).toBeNull();
  });
});

describe('shouldNotify', () => {
  it('newer latest, nothing dismissed → true', () => {
    expect(shouldNotify('0.1.0', '0.2.0', undefined)).toBe(true);
  });

  it('equal version → false', () => {
    expect(shouldNotify('0.1.0', '0.1.0', undefined)).toBe(false);
  });

  it('older latest → false', () => {
    expect(shouldNotify('0.2.0', '0.1.0', undefined)).toBe(false);
  });

  it('newer but dismissed exactly this version → false', () => {
    expect(shouldNotify('0.1.0', '0.2.0', '0.2.0')).toBe(false);
  });

  it('newer than the dismissed one → true again', () => {
    expect(shouldNotify('0.1.0', '0.3.0', '0.2.0')).toBe(true);
  });

  it('dismissed an older version does not silence equal/older latest', () => {
    expect(shouldNotify('0.2.0', '0.2.0', '0.1.0')).toBe(false);
    expect(shouldNotify('0.3.0', '0.2.0', '0.1.0')).toBe(false);
  });
});

describe('fetchLatestRelease (stubbed fetch)', () => {
  it('200 with a valid body → parsed release', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.2.0',
          html_url: 'https://github.com/redraaya/Redra/releases/tag/v0.2.0',
          draft: false,
          prerelease: false,
        }),
        { status: 200 },
      )) as typeof fetch;
    await expect(fetchLatestRelease('redraaya/Redra', stub)).resolves.toEqual({
      version: '0.2.0',
      url: 'https://github.com/redraaya/Redra/releases/tag/v0.2.0',
    });
  });

  it('network throw → null (offline stays noiseless)', async () => {
    const stub = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(fetchLatestRelease('redraaya/Redra', stub)).resolves.toBeNull();
  });

  it('non-200 → null', async () => {
    const stub = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await expect(fetchLatestRelease('redraaya/Redra', stub)).resolves.toBeNull();
  });
});

describe('settings: dismissedUpdateVersion', () => {
  it('sanitize accepts a string and drops anything else', () => {
    expect(sanitizeSettings({ dismissedUpdateVersion: '0.2.0' }).dismissedUpdateVersion).toBe(
      '0.2.0',
    );
    expect(sanitizeSettings({ dismissedUpdateVersion: 42 }).dismissedUpdateVersion).toBeUndefined();
    expect(sanitizeSettings({}).dismissedUpdateVersion).toBeUndefined();
  });

  it('merge keeps current value when the patch has none', () => {
    const cur = sanitizeSettings({ dismissedUpdateVersion: '0.2.0' });
    expect(mergeSettings(cur, { shellTheme: 'dark' }).dismissedUpdateVersion).toBe('0.2.0');
    expect(mergeSettings(cur, { dismissedUpdateVersion: '0.3.0' }).dismissedUpdateVersion).toBe(
      '0.3.0',
    );
  });
});
