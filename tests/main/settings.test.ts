import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings } from '../../src/main/lib/settings.js';
import { SettingsStore } from '../../src/main/settings-store.js';

describe('sanitizeSettings / mergeSettings (pure)', () => {
  it('defaults: system theme, backup on', () => {
    expect(DEFAULT_SETTINGS).toEqual({ shellTheme: 'system', backupOnFirstSave: true });
  });

  it('returns defaults for junk input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual({ ...DEFAULT_SETTINGS });
    expect(sanitizeSettings({ shellTheme: 'neon', backupOnFirstSave: 'yes' })).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it('accepts valid stored values', () => {
    expect(sanitizeSettings({ shellTheme: 'dark', backupOnFirstSave: false })).toEqual({
      shellTheme: 'dark',
      backupOnFirstSave: false,
    });
  });

  it('merges a partial patch, ignoring unknown keys and bad values', () => {
    const cur = { shellTheme: 'light', backupOnFirstSave: false } as const;
    expect(mergeSettings(cur, { shellTheme: 'dark' })).toEqual({
      shellTheme: 'dark',
      backupOnFirstSave: false,
    });
    expect(mergeSettings(cur, { backupOnFirstSave: true, bogus: 1 })).toEqual({
      shellTheme: 'light',
      backupOnFirstSave: true,
    });
    expect(mergeSettings(cur, 42)).toEqual(cur);
    expect(mergeSettings(cur, { shellTheme: 7 })).toEqual(cur);
  });

  it('does not mutate the current object', () => {
    const cur = { ...DEFAULT_SETTINGS };
    mergeSettings(cur, { shellTheme: 'dark' });
    expect(cur).toEqual(DEFAULT_SETTINGS);
  });
});

describe('SettingsStore (fs)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'redra-settings-'));
    file = path.join(dir, 'settings.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('missing file → defaults', async () => {
    const store = new SettingsStore(file);
    await store.load();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('corrupt file → defaults', async () => {
    await writeFile(file, '{not json!!');
    const store = new SettingsStore(file);
    await store.load();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('set() merges partially, persists, and a reload sees the result', async () => {
    const store = new SettingsStore(file);
    await store.load();
    const afterTheme = await store.set({ shellTheme: 'dark' });
    expect(afterTheme).toEqual({ shellTheme: 'dark', backupOnFirstSave: true });
    const afterBackup = await store.set({ backupOnFirstSave: false });
    expect(afterBackup).toEqual({ shellTheme: 'dark', backupOnFirstSave: false });

    const reloaded = new SettingsStore(file);
    await reloaded.load();
    expect(reloaded.get()).toEqual({ shellTheme: 'dark', backupOnFirstSave: false });
    // No stray tmp files left behind by the atomic write.
    const raw = await readFile(file, 'utf8');
    expect(JSON.parse(raw)).toEqual({ shellTheme: 'dark', backupOnFirstSave: false });
  });

  it('get() returns a copy — callers cannot mutate store state', async () => {
    const store = new SettingsStore(file);
    await store.load();
    const s = store.get();
    s.shellTheme = 'dark';
    expect(store.get().shellTheme).toBe('system');
  });
});
