import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentManager } from '../../src/main/document-manager.js';
import { PerfLog } from '../../src/main/lib/perf.js';

/**
 * Stage 7 — new file (⌘N). An untitled Markdown document lives only in memory
 * until its first save: it is savable but not dirty, a plain save() asks for a
 * path, and the first Save-As writes the starter and turns it into a real file.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'redra-untitled-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const placeholder = () => path.join(dir, 'Untitled.md');

describe('DocumentManager: untitled (new) Markdown document', () => {
  it('creates an in-memory md doc with the title, placeholder heading and no file on disk', async () => {
    const dm = new DocumentManager(new PerfLog());
    const { opened } = dm.openUntitled(placeholder(), 'Heading');

    expect(opened.format).toBe('md');
    expect(opened.isUntitled).toBe(true);
    expect(path.basename(opened.filePath)).toBe('Untitled.md');
    expect(opened.stampedHtml).toContain('data-redra-format="md"');
    // The lone empty heading carries the localized placeholder attribute.
    expect(opened.stampedHtml).toContain('data-redra-ph="Heading"');
    expect(opened.stampedHtml).toContain('<h1 data-redra-id="m0"');
    // Nothing was written.
    await expect(stat(opened.filePath)).rejects.toBeTruthy();
  });

  it('is savable but not dirty while pristine (closes silently, Save stays live)', () => {
    const dm = new DocumentManager(new PerfLog());
    dm.openUntitled(placeholder(), 'Heading');
    expect(dm.isDirty()).toBe(false);
    expect(dm.canSave()).toBe(true);
  });

  it('a plain save() asks for a path instead of writing to the placeholder', async () => {
    const dm = new DocumentManager(new PerfLog());
    const { opened } = dm.openUntitled(placeholder(), 'Heading');
    const res = await dm.save();
    expect(res).toEqual({ ok: false, needsPath: true });
    await expect(stat(opened.filePath)).rejects.toBeTruthy(); // still nothing on disk
  });

  it('first Save-As writes the starter, becomes a real file, and is no longer savable when clean', async () => {
    const dm = new DocumentManager(new PerfLog());
    dm.openUntitled(placeholder(), 'Heading');
    const target = path.join(dir, 'note.md');
    const res = await dm.save(target);
    expect(res.ok).toBe(true);

    const saved = await readFile(target, 'utf8');
    expect(saved).toBe('# '); // the empty-heading starter, verbatim
    const cur = dm.currentDoc!;
    expect(cur.isUntitled).toBe(false);
    expect(cur.filePath).toBe(path.resolve(target));
    expect(cur.dir).toBe(path.dirname(path.resolve(target)));
    // Clean + titled now → not savable until the next edit.
    expect(dm.canSave()).toBe(false);
    expect(dm.isDirty()).toBe(false);
  });

  it('typing into the heading then Save-As writes the edited heading', async () => {
    const dm = new DocumentManager(new PerfLog());
    const { opened } = dm.openUntitled(placeholder(), 'Heading');
    opened.journal.push({ type: 'editText', id: 'm0', html: 'Мой заголовок' });
    expect(dm.isDirty()).toBe(true);

    const target = path.join(dir, 'note.md');
    const res = await dm.save(target);
    expect(res.ok).toBe(true);
    const saved = await readFile(target, 'utf8');
    expect(saved).toContain('# Мой заголовок');
    expect(saved).not.toContain('data-redra'); // markdown, never stamped html
  });

  it('a saved untitled doc reopens as a normal titled md document', async () => {
    const dm = new DocumentManager(new PerfLog());
    const { opened } = dm.openUntitled(placeholder(), 'Heading');
    opened.journal.push({ type: 'editText', id: 'm0', html: 'Заголовок и текст' });
    const target = path.join(dir, 'note.md');
    await dm.save(target);

    const { opened: re } = await new DocumentManager(new PerfLog()).open(target);
    expect(re.format).toBe('md');
    expect(re.isUntitled).toBe(false);
    expect(re.stampedHtml).toContain('Заголовок и текст');
  });
});
