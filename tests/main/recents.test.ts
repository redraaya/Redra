import { describe, expect, it } from 'vitest';
import { MAX_RECENTS, addRecent, sanitizeRecents, sanitizeTimes } from '../../src/main/lib/recents.js';

describe('addRecent', () => {
  it('prepends new entries (most-recent-first)', () => {
    expect(addRecent(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b']);
  });

  it('dedupes by moving an existing entry to the front', () => {
    expect(addRecent(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c']);
    expect(addRecent(['/a'], '/a')).toEqual(['/a']);
  });

  it('caps at MAX_RECENTS (10), dropping the oldest', () => {
    const list = Array.from({ length: 10 }, (_, i) => `/f${i}`);
    const next = addRecent(list, '/new');
    expect(next).toHaveLength(MAX_RECENTS);
    expect(next[0]).toBe('/new');
    expect(next).not.toContain('/f9');
    expect(next).toContain('/f8');
  });
});

describe('sanitizeRecents', () => {
  it('returns [] for non-arrays and filters junk entries', () => {
    expect(sanitizeRecents(null)).toEqual([]);
    expect(sanitizeRecents('nope')).toEqual([]);
    expect(sanitizeRecents([1, '/a', null, '', '/b', '/a'])).toEqual(['/a', '/b']);
  });

  it('caps oversized stored lists', () => {
    const big = Array.from({ length: 30 }, (_, i) => `/f${i}`);
    expect(sanitizeRecents(big)).toHaveLength(MAX_RECENTS);
  });
});

describe('sanitizeTimes', () => {
  it('returns {} for non-objects', () => {
    expect(sanitizeTimes(null, ['/a'])).toEqual({});
    expect(sanitizeTimes([1], ['/a'])).toEqual({});
    expect(sanitizeTimes('x', ['/a'])).toEqual({});
  });

  it('keeps only finite positive timestamps for paths still in the list', () => {
    const raw = { '/a': 100, '/gone': 200, '/b': 'soon', '/c': NaN, '/d': -5 };
    expect(sanitizeTimes(raw, ['/a', '/b', '/c', '/d'])).toEqual({ '/a': 100 });
  });
});
