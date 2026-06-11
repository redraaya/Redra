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

describe('DocumentManager backup setting (injected backupWriter)', () => {
  /** Fake central-backup writer: records calls, writes nothing anywhere. */
  function makeWriter() {
    const calls: Array<{ filePath: string; bytes: Buffer }> = [];
    const writer = async (filePath: string, bytes: Buffer): Promise<void> => {
      calls.push({ filePath, bytes });
    };
    return { calls, writer };
  }

  async function openWithEdit(dm: DocumentManager): Promise<string> {
    const file = path.join(dir, 'doc.html');
    await writeFile(file, '<!doctype html><html><head></head><body><p>hi</p></body></html>');
    const { opened } = await dm.open(file);
    opened.journal.push({ type: 'editText', id: pId(opened), html: 'EDITED' });
    return file;
  }

  it('hands the ORIGINAL bytes to the writer on first overwrite-save (default on), once per session', async () => {
    const dm = new DocumentManager(new PerfLog());
    const { calls, writer } = makeWriter();
    dm.setBackupWriter(writer);
    const file = await openWithEdit(dm);

    expect((await dm.save()).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filePath).toBe(file);
    expect(calls[0]!.bytes.toString('utf8')).toContain('<p>hi</p>'); // pre-edit bytes

    // Second save of the same session: backupDone gates a repeat.
    dm.currentDoc!.journal.push({ type: 'editText', id: pId(dm.currentDoc!), html: 'AGAIN' });
    expect((await dm.save()).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a throwing backupWriter fails the save with an actionable, prefixed message', async () => {
    const dm = new DocumentManager(new PerfLog());
    dm.setBackupWriter(async () => {
      throw new Error('disk full');
    });
    const file = await openWithEdit(dm);

    const res = await dm.save();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Не удалось создать резервную копию: disk full');
    // The user file was never touched.
    expect(await readFile(file, 'utf8')).toContain('<p>hi</p>');
  });

  it('setBackupEnabled(false) suppresses the backup', async () => {
    const dm = new DocumentManager(new PerfLog());
    const { calls, writer } = makeWriter();
    dm.setBackupWriter(writer);
    dm.setBackupEnabled(false);
    await openWithEdit(dm);
    expect((await dm.save()).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('no writer injected → save still succeeds, nothing backed up, no .bak next to the file', async () => {
    const dm = new DocumentManager(new PerfLog());
    const file = await openWithEdit(dm);
    expect((await dm.save()).ok).toBe(true);
    await expect(readFile(file + '.bak')).rejects.toThrow();
  });

  it('never writes a .bak next to the user file anymore', async () => {
    const dm = new DocumentManager(new PerfLog());
    const { writer } = makeWriter();
    dm.setBackupWriter(writer);
    const file = await openWithEdit(dm);
    expect((await dm.save()).ok).toBe(true);
    await expect(readFile(file + '.bak')).rejects.toThrow();
  });
});
