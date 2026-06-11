import { describe, expect, it } from 'vitest';
import { makeT, pickLang } from '../../src/shared/i18n.js';
import type { StringKey } from '../../src/shared/i18n.js';

describe('pickLang', () => {
  it('maps Russian locales to ru', () => {
    expect(pickLang('ru')).toBe('ru');
    expect(pickLang('ru-RU')).toBe('ru');
    expect(pickLang('ru_RU')).toBe('ru');
    expect(pickLang('RU')).toBe('ru');
  });

  it('maps everything else to en', () => {
    expect(pickLang('en')).toBe('en');
    expect(pickLang('en-US')).toBe('en');
    expect(pickLang('de-DE')).toBe('en');
    expect(pickLang('uk')).toBe('en'); // Ukrainian is NOT ru
    expect(pickLang('uk-UA')).toBe('en');
    expect(pickLang('be')).toBe('en'); // Belarusian is NOT ru
    expect(pickLang('')).toBe('en');
  });

  it('does not treat a bare ru- prefix of another tag as Russian', () => {
    expect(pickLang('rum')).toBe('en');
    expect(pickLang('run')).toBe('en');
  });
});

describe('makeT', () => {
  it('returns the requested language', () => {
    expect(makeT('ru')('menu.file')).toBe('Файл');
    expect(makeT('en')('menu.file')).toBe('File');
    expect(makeT('ru')('dialog.unsaved.discard')).toBe('Не сохранять');
    expect(makeT('en')('dialog.unsaved.discard')).toBe('Don’t Save');
  });

  it('keeps the {name} placeholder for the caller to interpolate', () => {
    const msg = makeT('en')('dialog.unsaved.message');
    expect(msg).toContain('{name}');
    expect(msg.replace('{name}', 'a.html')).toBe('Save changes to “a.html”?');
  });

  it('falls back to the key itself for unknown keys (untyped callers)', () => {
    // Typed keys make this impossible at compile time — simulate a stale key.
    const t = makeT('en');
    expect(t('no.such.key' as StringKey)).toBe('no.such.key');
  });
});
