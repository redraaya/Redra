import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentManager } from '../../src/main/document-manager.js';
import { PerfLog } from '../../src/main/lib/perf.js';
import { renderDocumentBody } from '../../src/md/index.js';
import type { OpenedDoc } from '../../src/main/document-manager.js';

/** Simulate the MD 2.0 edit flow: the view commits a (mutated) body. */
function commitBody(opened: OpenedDoc, mutate: (body: string) => string): void {
  const body = renderDocumentBody(opened.mdState!.mdDoc.blocks);
  opened.mdState!.liveBody = mutate(body);
  opened.mdState!.liveDirty = true;
  opened.mdState!.dirtyGen = 1;
  opened.mdState!.bodyGen = 1;
}

/**
 * Stage 3: a .md file opens as a Markdown document (rendered HTML served,
 * format flagged), edits save via the block-table splice preserving untouched
 * bytes, and an ops-free save is byte-identical. The HTML path is unaffected
 * (its own suite stays green unmodified).
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'redra-md-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SRC = `# Отчёт

Первый абзац, который **редактируем**.

- пункт один
- пункт два

> Цитата, которую не трогаем.
`;

describe('DocumentManager: Markdown documents', () => {
  it('opens a .md file as format=md and serves rendered, stamped HTML', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);

    expect(opened.format).toBe('md');
    expect(opened.mdState).toBeTruthy();
    expect(opened.stampedHtml).toContain('data-redra-format="md"');
    expect(opened.stampedHtml).toContain('<h1 data-redra-id="m0">Отчёт</h1>');
    expect(opened.stampedHtml).toContain('<strong>редактируем</strong>');
  });

  it('ops-free save is byte-identical to the source', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const dm = new DocumentManager(new PerfLog());
    await dm.open(file);
    const res = await dm.save();
    expect(res.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(SRC);
  });

  it('editing one block saves it back and preserves every other block byte-for-byte', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);

    // Edit the first paragraph (m1): the view commits a body with new text.
    commitBody(opened, (b) => b.replace('Первый абзац, который <strong>редактируем</strong>.', 'Совсем другой текст.'));
    const res = await dm.save();
    expect(res.ok).toBe(true);

    const saved = await readFile(file, 'utf8');
    expect(saved).toContain('Совсем другой текст.');
    expect(saved).not.toContain('Первый абзац, который');
    // Untouched blocks survived verbatim.
    expect(saved).toContain('- пункт один\n- пункт два');
    expect(saved).toContain('> Цитата, которую не трогаем.');
    expect(saved).toContain('# Отчёт');
    // Re-opens cleanly with the same block count.
    const { opened: re } = await new DocumentManager(new PerfLog()).open(file);
    expect(re.mdState!.mdDoc.blocks.length).toBe(opened.mdState!.mdDoc.blocks.length);
  });

  it('Save-As to a new .md path writes markdown, not html', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);
    commitBody(opened, (b) => b.replace('>Отчёт<', '>Новый заголовок<'));
    const target = path.join(dir, 'copy.md');
    const res = await dm.save(target);
    expect(res.ok).toBe(true);
    const saved = await readFile(target, 'utf8');
    expect(saved).toContain('# Новый заголовок');
    expect(saved).not.toContain('<h1');
  });

  it('a deleteBlock removes exactly that block on save', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);
    // The view deleted the list element (m2) from the body.
    commitBody(opened, (b) => b.replace(/<ul data-redra-id="m2">.*?<\/ul>/s, ''));
    await dm.save();
    const saved = await readFile(file, 'utf8');
    expect(saved).not.toContain('- пункт один');
    expect(saved).toContain('# Отчёт');
    expect(saved).toContain('> Цитата, которую не трогаем.');
  });
});

describe('MD 2.0 dirty/commit generation protocol', () => {
  it('liveDirty STAYS true after save when keystrokes outran the written body (dirtyGen > bodyGen)', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);
    const body = renderDocumentBody(opened.mdState!.mdDoc.blocks);
    opened.mdState!.liveBody = body.replace('Первый абзац', 'Новый абзац');
    opened.mdState!.liveDirty = true;
    opened.mdState!.bodyGen = 3; // the committed body captured gen 3
    opened.mdState!.dirtyGen = 5; // …but the user kept typing (gen 5 reported)
    const res = await dm.save();
    expect(res.ok).toBe(true);
    expect(opened.mdState!.liveDirty).toBe(true); // gens 4-5 are NOT on disk
    expect(dm.isDirty()).toBe(true);
  });

  it('liveDirty clears after save when the written body caught every report', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);
    const body = renderDocumentBody(opened.mdState!.mdDoc.blocks);
    opened.mdState!.liveBody = body.replace('Первый абзац', 'Новый абзац');
    opened.mdState!.liveDirty = true;
    opened.mdState!.dirtyGen = 5;
    opened.mdState!.bodyGen = 5;
    await dm.save();
    expect(opened.mdState!.liveDirty).toBe(false);
    expect(dm.isDirty()).toBe(false);
  });

  it('a commit WITHOUT edits (preview/pdf/telegram) does not make plain ⌘S rewrite the file', async () => {
    const file = path.join(dir, 'note.md');
    await writeFile(file, SRC);
    const before = (await stat(file)).mtimeMs;
    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(file);
    // Every commit point sends the body unconditionally — zero edits reported.
    opened.mdState!.liveBody = renderDocumentBody(opened.mdState!.mdDoc.blocks);
    opened.mdState!.bodyGen = 0;
    const res = await dm.save();
    expect(res.ok && 'skipped' in res && res.skipped).toBe(true);
    expect((await stat(file)).mtimeMs).toBe(before); // no mtime churn, no backup
  });
});
