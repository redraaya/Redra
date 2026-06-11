import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupStore } from '../../src/main/lib/backups.js';

let dir: string;
let store: BackupStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'redra-bak-'));
  store = new BackupStore(path.join(dir, 'backups')); // dir does not pre-exist
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('BackupStore.backupFor', () => {
  it('writes the bytes under <basename>.<hash8>.orig.html and returns the path', async () => {
    const src = path.join(dir, 'отчёт.html');
    const out = await store.backupFor(src, Buffer.from('<p>оригинал</p>'));

    expect(path.dirname(out)).toBe(path.join(dir, 'backups'));
    expect(path.basename(out)).toMatch(/^отчёт\.html\.[0-9a-f]{8}\.orig\.html$/);
    expect(await readFile(out, 'utf8')).toBe('<p>оригинал</p>');
  });

  it('hashes the FULL path: same basename in different folders never collides', async () => {
    const a = await store.backupFor(path.join(dir, 'a', 'doc.html'), Buffer.from('A'));
    const b = await store.backupFor(path.join(dir, 'b', 'doc.html'), Buffer.from('B'));
    expect(a).not.toBe(b);
    expect(await readFile(a, 'utf8')).toBe('A');
    expect(await readFile(b, 'utf8')).toBe('B');
  });

  it('is deterministic for one path: backupPathFor always yields the same name', () => {
    const src = path.join(dir, 'doc.html');
    expect(store.backupPathFor(src)).toBe(store.backupPathFor(src));
  });

  it('OVERWRITES an existing backup: each session\'s first save refreshes it with that session\'s original bytes', async () => {
    const src = path.join(dir, 'doc.html');
    const first = await store.backupFor(src, Buffer.from('FIRST'));
    const second = await store.backupFor(src, Buffer.from('SECOND'));
    expect(second).toBe(first); // same deterministic path
    expect(await readFile(first, 'utf8')).toBe('SECOND'); // refreshed, like .bak was
  });
});

describe('BackupStore.prune', () => {
  it('removes the oldest entries (by mtime) beyond keep', async () => {
    const stamps: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = await store.backupFor(path.join(dir, `doc${i}.html`), Buffer.from(`v${i}`));
      const when = new Date(Date.now() - (5 - i) * 60_000); // doc0 oldest … doc4 newest
      await utimes(out, when, when);
      stamps.push(out);
    }

    await store.prune(2);

    const left = (await readdir(path.join(dir, 'backups'))).sort();
    expect(left).toEqual([path.basename(stamps[3]!), path.basename(stamps[4]!)].sort());
  });

  it('keep=30 by default: nothing pruned for a handful of files', async () => {
    for (let i = 0; i < 3; i++) {
      await store.backupFor(path.join(dir, `doc${i}.html`), Buffer.from('x'));
    }
    await store.prune();
    expect(await readdir(path.join(dir, 'backups'))).toHaveLength(3);
  });

  it('ignores foreign files in the directory', async () => {
    await store.backupFor(path.join(dir, 'doc.html'), Buffer.from('x'));
    const foreign = path.join(dir, 'backups', 'notes.txt');
    await writeFile(foreign, 'keep me');
    await store.prune(0);
    expect(await readdir(path.join(dir, 'backups'))).toEqual(['notes.txt']);
  });

  it('survives a missing directory', async () => {
    const empty = new BackupStore(path.join(dir, 'never-created'));
    await expect(empty.prune()).resolves.toBeUndefined();
  });
});
