import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../../src/shared/relative-time.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Fixed "now": 2026-06-11 12:00 local time.
const NOW = new Date(2026, 5, 11, 12, 0, 0).getTime();

describe('formatRelativeTime', () => {
  it('«только что» under a minute', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('только что');
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('только что');
  });

  it('treats future timestamps (clock skew) as «только что»', () => {
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe('только что');
  });

  it('«N мин назад» under an hour', () => {
    expect(formatRelativeTime(NOW - MIN, NOW)).toBe('1 мин назад');
    expect(formatRelativeTime(NOW - 2 * MIN, NOW)).toBe('2 мин назад');
    expect(formatRelativeTime(NOW - 59 * MIN - 59_000, NOW)).toBe('59 мин назад');
  });

  it('«N ч назад» under a day', () => {
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe('1 ч назад');
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe('23 ч назад');
  });

  it('«вчера» between one and two days', () => {
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe('вчера');
    expect(formatRelativeTime(NOW - 2 * DAY + 1, NOW)).toBe('вчера');
  });

  it('«N дн назад» under a week', () => {
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe('2 дн назад');
    expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe('6 дн назад');
  });

  it('date DD.MM.YYYY from a week on', () => {
    expect(formatRelativeTime(NOW - 7 * DAY, NOW)).toBe('04.06.2026');
    expect(formatRelativeTime(new Date(2025, 0, 3, 9, 30).getTime(), NOW)).toBe('03.01.2025');
  });

  it('defaults to Russian when lang is omitted', () => {
    expect(formatRelativeTime(NOW - MIN, NOW)).toBe('1 мин назад');
  });

  describe('English branch', () => {
    it('"just now" under a minute (incl. clock skew)', () => {
      expect(formatRelativeTime(NOW, NOW, 'en')).toBe('just now');
      expect(formatRelativeTime(NOW + 5 * MIN, NOW, 'en')).toBe('just now');
    });

    it('"N min ago" under an hour', () => {
      expect(formatRelativeTime(NOW - MIN, NOW, 'en')).toBe('1 min ago');
      expect(formatRelativeTime(NOW - 59 * MIN - 59_000, NOW, 'en')).toBe('59 min ago');
    });

    it('"N h ago" under a day', () => {
      expect(formatRelativeTime(NOW - HOUR, NOW, 'en')).toBe('1 h ago');
      expect(formatRelativeTime(NOW - 23 * HOUR, NOW, 'en')).toBe('23 h ago');
    });

    it('"yesterday" between one and two days', () => {
      expect(formatRelativeTime(NOW - DAY, NOW, 'en')).toBe('yesterday');
    });

    it('"N d ago" under a week', () => {
      expect(formatRelativeTime(NOW - 2 * DAY, NOW, 'en')).toBe('2 d ago');
      expect(formatRelativeTime(NOW - 6 * DAY, NOW, 'en')).toBe('6 d ago');
    });

    it('numeric date fallback is the same in both languages', () => {
      expect(formatRelativeTime(NOW - 7 * DAY, NOW, 'en')).toBe('04.06.2026');
    });
  });
});
