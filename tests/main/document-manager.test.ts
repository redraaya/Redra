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

describe('DocumentManager.openFromBackup (version history restore)', () => {
  const original = '<!doctype html><html><head></head><body><p>версия 1</p></body></html>';

  /** Open `doc.html`, edit, save (disk = v2, backup = v1), return the pieces. */
  async function setupEditedDoc() {
    const file = path.join(dir, 'doc.html');
    await writeFile(file, original);
    const dm = new DocumentManager(new PerfLog());
    const backups: Array<{ filePath: string; bytes: Buffer }> = [];
    dm.setBackupWriter(async (filePath, bytes) => {
      backups.push({ filePath, bytes });
    });
    const { opened } = await dm.open(file);
    opened.journal.push({ type: 'editText', id: pId(opened), html: 'версия 2' });
    expect((await dm.save()).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('версия 2');
    // Simulate the central store: the backup file holds the v1 bytes.
    const backupPath = path.join(dir, 'doc.html.aabbccdd.20260612-102030.orig.html');
    await writeFile(backupPath, backups[0]!.bytes);
    return { dm, file, backupPath, backups };
  }

  it('full restore-save round-trip: safety backup + no skip-write + flag cleared', async () => {
    const { dm, file, backupPath, backups } = await setupEditedDoc();
    const oldDocId = dm.currentDoc!.docId;

    const { opened } = await dm.openFromBackup(backupPath);

    // The restore itself is undoable: pre-restore DISK bytes (v2) were backed up.
    expect(backups).toHaveLength(2);
    expect(backups[1]!.filePath).toBe(file);
    expect(backups[1]!.bytes.toString('utf8')).toContain('версия 2');

    // The document is the backup content under the SAME path, marked dirty.
    expect(opened.filePath).toBe(file);
    expect(opened.docId).not.toBe(oldDocId);
    expect(opened.journal.dirty).toBe(false); // ops-based journal stays clean…
    expect(dm.isDirty()).toBe(true); // …the restored flag carries the dirty state
    expect(opened.stampedHtml).toContain('версия 1');

    // Save with an EMPTY journal must WRITE (no skip): disk returns to v1.
    const saved = await dm.save();
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.skipped).not.toBe(true);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(dm.isDirty()).toBe(false); // flag cleared by the successful save

    // And the next no-op save skips again, as usual.
    expect(await dm.save()).toMatchObject({ ok: true, skipped: true });
  });

  it('re-stats the file at restore time so the save does not false-conflict', async () => {
    const { dm, file, backupPath } = await setupEditedDoc();
    // External mtime bump AFTER our last save — normally a conflict…
    const future = new Date(Date.now() + 5_000);
    await utimes(file, future, future);
    await dm.openFromBackup(backupPath);
    // …but the restore adopted the current on-disk state as the base.
    expect((await dm.save()).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('editing after a restore works on the restored tree', async () => {
    const { dm, backupPath, file } = await setupEditedDoc();
    const { opened } = await dm.openFromBackup(backupPath);
    opened.journal.push({ type: 'editText', id: pId(opened), html: 'правка поверх восстановленного' });
    expect((await dm.save()).ok).toBe(true);
    const onDisk = await readFile(file, 'utf8');
    expect(onDisk).toContain('правка поверх восстановленного');
    expect(onDisk).not.toContain('версия 2');
  });

  it('throws without an open document and leaves no state behind', async () => {
    const dm = new DocumentManager(new PerfLog());
    await expect(dm.openFromBackup('/nowhere.orig.html')).rejects.toThrow();
    expect(dm.currentDoc).toBeNull();
  });

  it('a missing backup file fails the restore and keeps the current document', async () => {
    const { dm, backupPath } = await setupEditedDoc();
    const before = dm.currentDoc!;
    await expect(dm.openFromBackup(backupPath + '.gone')).rejects.toThrow();
    expect(dm.currentDoc).toBe(before);
    expect(dm.isDirty()).toBe(false);
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
