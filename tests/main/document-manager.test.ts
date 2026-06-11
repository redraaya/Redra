import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentManager } from '../../src/main/document-manager.js';
import { PerfLog } from '../../src/main/lib/perf.js';
import type { OpenedDoc } from '../../src/main/document-manager.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'redra-dm-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Id of the first <p> in the opened document (for editText ops). */
function pId(opened: OpenedDoc): string {
  for (const [el, id] of opened.doc.nodeToId) {
    if (el.tagName === 'p') return id;
  }
  throw new Error('no <p> in fixture');
}

describe('DocumentManager.save', () => {
  it('skips the write on a fresh open with no ops', async () => {
    const file = path.join(dir, 'doc.html');
    await writeFile(file, '<!doctype html><html><head></head><body><p>hi</p></body></html>');
    const dm = new DocumentManager(new PerfLog());
    await dm.open(file);

    const res = await dm.save();
    expect(res).toMatchObject({ ok: true, skipped: true });
  });

  it('restores the original bytes after save → undo-all → save', async () => {
    const original = '<!doctype html><html><head></head><body><p>hi</p></body></html>';
    const file = path.join(dir, 'doc.html');
    await writeFile(file, original);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);

    opened.journal.push({ type: 'editText', id: pId(opened), html: 'EDITED' });
    const first = await dm.save();
    expect(first.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('EDITED');

    opened.journal.undo();
    expect(opened.journal.dirty).toBe(true);

    const second = await dm.save();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skipped).not.toBe(true);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(opened.journal.dirty).toBe(false);
  });

  it('rewrites a lying meta charset when the file had a utf-8 BOM', async () => {
    const body =
      '<!doctype html><html><head><meta charset="windows-1251"></head>' +
      '<body><p>Привет</p></body></html>';
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    const file = path.join(dir, 'bom.html');
    await writeFile(file, bytes);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);

    opened.journal.push({ type: 'editText', id: pId(opened), html: 'Мир' });
    const res = await dm.save();
    expect(res.ok).toBe(true);

    const saved = await readFile(file, 'utf8');
    expect(saved).toContain('charset="utf-8"');
    expect(saved).not.toContain('windows-1251');
  });
});

describe('DocumentManager mtime conflict', () => {
  it('reports conflict after an external mtime bump; acceptExternalMtime unblocks the save', async () => {
    const file = path.join(dir, 'doc.html');
    await writeFile(file, '<!doctype html><html><head></head><body><p>hi</p></body></html>');
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);
    opened.journal.push({ type: 'editText', id: pId(opened), html: 'EDITED' });

    // Someone touches the file on disk behind our back.
    const future = new Date(Date.now() + 5_000);
    await utimes(file, future, future);

    const res = await dm.save();
    expect(res).toMatchObject({ ok: false, conflict: true });
    // «Отмена» path: nothing was written, the journal stays dirty.
    expect(opened.journal.dirty).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('<p>hi</p>');

    // «Перезаписать» path: adopt the external mtime, then the save goes through.
    await dm.acceptExternalMtime();
    const retried = await dm.save();
    expect(retried.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('EDITED');
    expect(opened.journal.dirty).toBe(false);
  });
});

describe('DocumentManager backup setting', () => {
  async function openWithEdit(dm: DocumentManager): Promise<string> {
    const file = path.join(dir, 'doc.html');
    await writeFile(file, '<!doctype html><html><head></head><body><p>hi</p></body></html>');
    const { opened } = await dm.open(file);
    opened.journal.push({ type: 'editText', id: pId(opened), html: 'EDITED' });
    return file;
  }

  it('writes <name>.html.bak with original bytes on first overwrite-save (default on)', async () => {
    const dm = new DocumentManager(new PerfLog());
    const file = await openWithEdit(dm);
    expect((await dm.save()).ok).toBe(true);
    const bak = await readFile(file + '.bak', 'utf8');
    expect(bak).toContain('<p>hi</p>');
  });

  it('setBackupEnabled(false) suppresses the .bak', async () => {
    const dm = new DocumentManager(new PerfLog());
    dm.setBackupEnabled(false);
    const file = await openWithEdit(dm);
    expect((await dm.save()).ok).toBe(true);
    await expect(readFile(file + '.bak')).rejects.toThrow();
  });
});
