import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupStore } from '../../src/main/lib/backups.js';

let dir: string;
let store: BackupStore;

/** 2026-06-12 10:20:30 local — a fixed, parseable reference instant. */
const T0 = new Date(2026, 5, 12, 10, 20, 30).getTime();
const MIN = 60_000;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'redra-bak-'));
  store = new BackupStore(path.join(dir, 'backups')); // dir does not pre-exist
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('BackupStore.backupFor (timestamped)', () => {
  it('writes the bytes under <basename>.<hash8>.<YYYYMMDD-HHmmss>.orig.html', async () => {
    const src = path.join(dir, 'отчёт.html');
    const out = await store.backupFor(src, Buffer.from('<p>оригинал</p>'), T0);

    expect(path.dirname(out)).toBe(path.join(dir, 'backups'));
    expect(path.basename(out)).toMatch(/^отчёт\.html\.[0-9a-f]{8}\.20260612-102030\.orig\.html$/);
    expect(await readFile(out, 'utf8')).toBe('<p>оригинал</p>');
  });

  it('different timestamps yield DIFFERENT files — versions accumulate', async () => {
    const src = path.join(dir, 'doc.html');
    const a = await store.backupFor(src, Buffer.from('FIRST'), T0);
    const b = await store.backupFor(src, Buffer.from('SECOND'), T0 + MIN);
    expect(a).not.toBe(b);
    expect(await readFile(a, 'utf8')).toBe('FIRST');
    expect(await readFile(b, 'utf8')).toBe('SECOND');
  });

  it('same-second writes get a -2/-3 uniquifier instead of overwriting each other', async () => {
    const src = path.join(dir, 'doc.html');
    const a = await store.backupFor(src, Buffer.from('FIRST'), T0);
    const b = await store.backupFor(src, Buffer.from('SECOND'), T0);
    const c = await store.backupFor(src, Buffer.from('THIRD'), T0);

    expect(path.basename(b)).toBe(path.basename(a).replace('.orig.html', '-2.orig.html'));
    expect(path.basename(c)).toBe(path.basename(a).replace('.orig.html', '-3.orig.html'));
    expect(await readFile(a, 'utf8')).toBe('FIRST');
    expect(await readFile(b, 'utf8')).toBe('SECOND');
    expect(await readFile(c, 'utf8')).toBe('THIRD');

    // All three are versions of the SAME document, same savedAt second.
    const entries = await store.list(src);
    expect(entries.map((e) => e.path).sort()).toEqual([a, b, c].sort());
    expect(entries.every((e) => e.savedAt === T0)).toBe(true);

    // And prune treats them as ordinary versions of one document.
    await store.prune(1, 100);
    expect(await readdir(path.join(dir, 'backups'))).toHaveLength(1);
  });

  it('hashes the FULL path: same basename in different folders never collides', async () => {
    const a = await store.backupFor(path.join(dir, 'a', 'doc.html'), Buffer.from('A'), T0);
    const b = await store.backupFor(path.join(dir, 'b', 'doc.html'), Buffer.from('B'), T0);
    expect(a).not.toBe(b);
  });

  it('is deterministic: backupPathFor(path, at) always yields the same name', () => {
    const src = path.join(dir, 'doc.html');
    expect(store.backupPathFor(src, T0)).toBe(store.backupPathFor(src, new Date(T0)));
  });
});

describe('BackupStore.list', () => {
  it('lists versions of ONE document, newest first, with savedAt and size', async () => {
    const src = path.join(dir, 'doc.html');
    const other = path.join(dir, 'other.html');
    const old = await store.backupFor(src, Buffer.from('v-old'), T0);
    const fresh = await store.backupFor(src, Buffer.from('v-fresh!'), T0 + MIN);
    await store.backupFor(other, Buffer.from('foreign'), T0); // different doc

    const entries = await store.list(src);
    expect(entries.map((e) => e.path)).toEqual([fresh, old]);
    expect(entries[0]!.savedAt).toBe(T0 + MIN);
    expect(entries[1]!.savedAt).toBe(T0);
    expect(entries[0]!.size).toBe(8); // 'v-fresh!'
    expect(entries[1]!.size).toBe(5);
  });

  it('includes legacy v0.1.x un-timestamped backups with savedAt from mtime', async () => {
    const src = path.join(dir, 'doc.html');
    const timestamped = await store.backupFor(src, Buffer.from('new'), T0 + MIN);
    // A legacy file: <base>.<hash8>.orig.html (same key, no timestamp).
    const legacy = store.backupPathFor(src, T0).replace('.20260612-102030', '');
    await writeFile(legacy, 'legacy bytes');
    await utimes(legacy, new Date(T0 - MIN), new Date(T0 - MIN));

    const entries = await store.list(src);
    expect(entries.map((e) => e.path)).toEqual([timestamped, legacy]);
    expect(entries[1]!.savedAt).toBeCloseTo(T0 - MIN, -3);
  });

  it('ignores foreign files and survives a missing directory', async () => {
    const empty = new BackupStore(path.join(dir, 'never-created'));
    expect(await empty.list('/tmp/doc.html')).toEqual([]);

    const src = path.join(dir, 'doc.html');
    await store.backupFor(src, Buffer.from('x'), T0);
    await writeFile(path.join(dir, 'backups', 'notes.txt'), 'not a backup');
    expect(await store.list(src)).toHaveLength(1);
  });
});

describe('BackupStore.prune (per-file + global)', () => {
  it('keeps the newest perFileKeep versions of each document', async () => {
    const src = path.join(dir, 'doc.html');
    const kept: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = await store.backupFor(src, Buffer.from(`v${i}`), T0 + i * MIN);
      if (i >= 3) kept.push(out); // the 2 newest
    }
    await store.prune(2, 100);
    const left = (await readdir(path.join(dir, 'backups'))).sort();
    expect(left).toEqual(kept.map((p) => path.basename(p)).sort());
  });

  it('then trims the store to globalKeep files overall (oldest go first)', async () => {
    const outs: string[] = [];
    for (let i = 0; i < 4; i++) {
      outs.push(await store.backupFor(path.join(dir, `doc${i}.html`), Buffer.from('x'), T0 + i * MIN));
    }
    await store.prune(10, 2);
    const left = (await readdir(path.join(dir, 'backups'))).sort();
    expect(left).toEqual([path.basename(outs[2]!), path.basename(outs[3]!)].sort());
  });

  it('counts legacy entries via mtime and prunes them like the rest', async () => {
    const src = path.join(dir, 'doc.html');
    await store.backupFor(src, Buffer.from('new1'), T0 + MIN);
    await store.backupFor(src, Buffer.from('new2'), T0 + 2 * MIN);
    const legacy = store.backupPathFor(src, T0).replace('.20260612-102030', '');
    await writeFile(legacy, 'oldest');
    await utimes(legacy, new Date(T0 - MIN), new Date(T0 - MIN));

    await store.prune(2, 100);
    const left = await readdir(path.join(dir, 'backups'));
    expect(left).toHaveLength(2);
    expect(left).not.toContain(path.basename(legacy));
  });

  it('defaults: keep 10 per file / 100 global — a handful of files all survive', async () => {
    for (let i = 0; i < 3; i++) {
      await store.backupFor(path.join(dir, `doc${i}.html`), Buffer.from('x'), T0 + i * MIN);
    }
    await store.prune();
    expect(await readdir(path.join(dir, 'backups'))).toHaveLength(3);
  });

  it('ignores foreign files and survives a missing directory', async () => {
    await store.backupFor(path.join(dir, 'doc.html'), Buffer.from('x'), T0);
    await writeFile(path.join(dir, 'backups', 'notes.txt'), 'keep me');
    await store.prune(0, 0);
    expect(await readdir(path.join(dir, 'backups'))).toEqual(['notes.txt']);

    const empty = new BackupStore(path.join(dir, 'never-created'));
    await expect(empty.prune()).resolves.toBeUndefined();
  });
});
