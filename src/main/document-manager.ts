import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Journal, parseDocument, serializeForView, serializeSource } from '../engine/index.js';
import type { RedraDoc } from '../engine/index.js';
import { writeAtomic } from './lib/atomic-write.js';
import { ensureUtf8Charset } from './lib/charset-rewrite.js';
import { decodeHtml } from './lib/encoding.js';
import type { PerfLog } from './lib/perf.js';
import type { SaveResult } from '../shared/ipc.js';

export interface OpenedDoc {
  docId: string;
  filePath: string;
  /** Directory the redra:// protocol serves relative resources from. */
  dir: string;
  doc: RedraDoc;
  journal: Journal;
  /** Raw bytes as read from disk at open time (verbatim source for ops-free saves and backups). */
  originalBytes: Buffer;
  /** Canonical encoding the file was decoded with. */
  encoding: string;
  /** True when the source bytes started with a BOM (saved output never re-emits it). */
  hadBom: boolean;
  /** Stamped HTML served at redra://doc/<docId>/. */
  stampedHtml: string;
  /** mtime at open / after our last successful save — for the conflict guard. */
  lastKnownMtimeMs: number;
  /** True once the session backup has been written (or is not needed). */
  backupDone: boolean;
}

export interface OpenTimings {
  readMs: number;
  decodeMs: number;
  parseMs: number;
  stampMs: number;
  totalMs: number;
}

/**
 * Stores the ORIGINAL bytes of `filePath` somewhere safe before the first
 * overwrite. Injected by main (wired to BackupStore in userData/backups)
 * so this class stays Electron-free and the destination is testable.
 */
export type BackupWriter = (filePath: string, bytes: Buffer) => Promise<void>;

/**
 * Owns the currently opened document (single-window v1: re-open replaces it).
 * All Electron-facing wiring (views, dialogs, IPC) lives in index.ts;
 * this class only touches fs + the engine, so it stays thin and portable.
 */
export class DocumentManager {
  private current: OpenedDoc | null = null;
  /** Back up the ORIGINAL bytes on first overwrite-save (user setting). */
  private backupEnabled = true;
  private backupWriter: BackupWriter | null = null;

  constructor(private readonly perf: PerfLog) {}

  get currentDoc(): OpenedDoc | null {
    return this.current;
  }

  setBackupEnabled(on: boolean): void {
    this.backupEnabled = on;
  }

  setBackupWriter(writer: BackupWriter | null): void {
    this.backupWriter = writer;
  }

  /**
   * Conflict resolution «Перезаписать»: adopt the on-disk mtime as ours so the
   * next save() passes the guard and overwrites the external change.
   */
  async acceptExternalMtime(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    const st = await fs.stat(cur.filePath).catch(() => null);
    if (st) cur.lastKnownMtimeMs = st.mtimeMs;
  }

  async open(filePath: string): Promise<{ opened: OpenedDoc; timings: OpenTimings }> {
    const t0 = performance.now();
    const originalBytes = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    const tRead = performance.now();

    const { text, encoding, hadBom } = decodeHtml(originalBytes);
    const tDecode = performance.now();

    const doc = parseDocument(text);
    const tParse = performance.now();

    const stampedHtml = serializeForView(doc);
    const tStamp = performance.now();

    const opened: OpenedDoc = {
      docId: randomUUID(),
      filePath: path.resolve(filePath),
      dir: path.dirname(path.resolve(filePath)),
      doc,
      journal: new Journal(),
      originalBytes,
      encoding,
      hadBom,
      stampedHtml,
      lastKnownMtimeMs: stat.mtimeMs,
      backupDone: false,
    };
    this.current = opened; // replaces any previous doc; its docId now 404s

    const timings: OpenTimings = {
      readMs: tRead - t0,
      decodeMs: tDecode - tRead,
      parseMs: tParse - tDecode,
      stampMs: tStamp - tParse,
      totalMs: tStamp - t0,
    };
    return { opened, timings };
  }

  /** Drop the current document (single-window v1: it dies with its window). */
  close(): void {
    this.current = null;
  }

  /** Lookup for the redra:// protocol handler. Unknown/stale docId → undefined → 404. */
  getServed(docId: string): { dir: string; html: string } | undefined {
    const cur = this.current;
    if (!cur || cur.docId !== docId) return undefined;
    return { dir: cur.dir, html: cur.stampedHtml };
  }

  /**
   * Save pipeline. `asPath` set ⇒ Save As.
   * - no ops + clean journal + same path ⇒ no-op, report ok (disk already verbatim)
   * - mtime conflict guard before overwriting
   * - first overwrite-save of a session hands the original bytes to backupWriter
   * - atomic write: tmp file in the same dir + rename
   */
  async save(asPath?: string): Promise<SaveResult> {
    const cur = this.current;
    if (!cur) return { ok: false, error: 'Документ не открыт' };

    const t0 = performance.now();
    const targetPath = path.resolve(asPath ?? cur.filePath);
    const overwritesCurrent = targetPath === cur.filePath;
    const ops = cur.journal.ops;

    // Save (not Save As) with no ops onto the same file AND a clean journal:
    // disk already holds originalBytes — skip the write. A dirty journal with
    // no ops (edit → save → undo-all) means disk holds the EDITED bytes, so
    // we must fall through and write originalBytes back.
    if (asPath === undefined && ops.length === 0 && !cur.journal.dirty) {
      this.perf.record('save-skipped-noop', performance.now() - t0);
      return { ok: true, path: targetPath, skipped: true };
    }

    // Conflict guard: someone changed the file since we opened / last saved it.
    if (overwritesCurrent) {
      const st = await fs.stat(targetPath).catch(() => null);
      if (st && st.mtimeMs !== cur.lastKnownMtimeMs) {
        return { ok: false, conflict: true };
      }
    }

    try {
      if (overwritesCurrent && this.backupEnabled && !cur.backupDone && this.backupWriter) {
        await this.backupWriter(targetPath, cur.originalBytes);
        cur.backupDone = true;
      }

      // With ops the serialized string is written as utf-8 (TextEncoder/Buffer
      // cannot produce legacy encodings). If the file was decoded from another
      // encoding, its <meta charset> would now lie — rewrite it to utf-8.
      // Same for BOM files: the BOM (which won at decode, possibly over a
      // lying meta) is not re-emitted, so the meta must tell the truth.
      let bytes: Buffer;
      if (ops.length === 0) {
        bytes = cur.originalBytes;
      } else {
        let html = serializeSource(cur.doc, ops);
        if (cur.encoding !== 'utf-8' || cur.hadBom) html = ensureUtf8Charset(html);
        bytes = Buffer.from(html, 'utf8');
      }

      await writeAtomic(targetPath, bytes);

      const st = await fs.stat(targetPath);
      cur.lastKnownMtimeMs = st.mtimeMs;
      if (!overwritesCurrent) {
        // Save As: the document now lives at the new path.
        cur.filePath = targetPath;
        cur.dir = path.dirname(targetPath);
        cur.backupDone = true; // we just wrote this file ourselves; no original to back up
      }
      cur.journal.markSaved();
      this.perf.record('save', performance.now() - t0, { bytes: bytes.length });
      return { ok: true, path: targetPath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
