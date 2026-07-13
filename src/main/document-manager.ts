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
import type { DocFormat } from '../shared/doc-types.js';
import { formatForPath } from '../shared/doc-types.js';
import { parseMd, serializeMdLive, newUntitledMd } from './format/md-doc.js';
import type { MdState } from './format/md-doc.js';

/** Placeholder RedraDoc for md documents: OpenedDoc.doc is HTML-typed and
 *  read only on the HTML path (save/guard/clone branch on `format`), so md
 *  docs park an empty one here rather than widen the field (which would ripple
 *  into every existing consumer and test). */
const EMPTY_HTML_DOC = (): RedraDoc => parseDocument('');

export interface OpenedDoc {
  docId: string;
  filePath: string;
  /** Directory the redra:// protocol serves relative resources from. */
  dir: string;
  /** 'html' (default) or 'md'. Save / ops-guard / clone branch on this. */
  format: DocFormat;
  doc: RedraDoc;
  /** Present only for format==='md' (the parsed markdown + flavor + clone set). */
  mdState?: MdState;
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
  /**
   * True after openFromBackup until the first successful save: disk holds a
   * NEWER state than originalBytes, so an ops-free save must still WRITE
   * (the skip-write shortcut is gated on this), and the document counts as
   * dirty (see isDirty) even with a clean journal.
   */
  restoredFromBackup: boolean;
  /**
   * A new (⌘N) document that has never been written: `filePath` is a mere
   * placeholder for the title / Save-As default, NOT a file on disk. save()
   * always routes through Save-As (needsPath) until the first write clears
   * this. A CLEAN untitled doc is NOT dirty — it closes silently — but it IS
   * savable (canSave), so ⌘S can commit the empty starter to disk.
   */
  isUntitled: boolean;
  /**
   * cloneBlock id mint: the next clone gets "c<counter+1>". Monotonic per
   * document and NEVER decremented (an undone cloneBlock still sits in the
   * journal's redo tail with its id — reuse would collide on redo).
   */
  cloneCounter: number;
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
 * Owns ONE window's opened document — every WindowContext gets its own
 * instance (one window = one document since v0.3.0; re-open into the same
 * context replaces the doc, e.g. on version restore). All Electron-facing
 * wiring (views, dialogs, IPC) lives in index.ts; this class only touches
 * fs + the engine, so it stays thin and portable.
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

  /**
   * The single source of "unsaved changes": ops in the journal OR a restored
   * backup that has not been written to disk yet. The shell dirty dot, the
   * close guard and the open-over-dirty guard all ask HERE — the journal
   * itself stays purely ops-based.
   */
  isDirty(): boolean {
    const cur = this.current;
    if (!cur) return false;
    // MD 2.0: markdown edits never enter the journal — the view reports
    // dirtiness via md:dirty into mdState.liveDirty. Missing this here would
    // silently skip saves and close edited windows without a prompt.
    return cur.journal.dirty || cur.restoredFromBackup || !!cur.mdState?.liveDirty;
  }

  /**
   * Is ⌘S meaningful right now? True when dirty, OR when the document is an
   * untitled starter that has never hit disk (its first save writes the empty
   * template). Kept separate from isDirty so the close guard stays silent on a
   * pristine untitled doc while its Save button stays live.
   */
  canSave(): boolean {
    const cur = this.current;
    return this.isDirty() || (!!cur && cur.isUntitled);
  }

  setBackupEnabled(on: boolean): void {
    this.backupEnabled = on;
  }

  setBackupWriter(writer: BackupWriter | null): void {
    this.backupWriter = writer;
  }

  /**
   * Conflict resolution "Overwrite": adopt the on-disk mtime as ours so the
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

    // decodeHtml is really "bytes → text with BOM strip + meta-charset sniff";
    // an .md file has no <meta charset> so it falls back to utf-8 — correct.
    const { text, encoding, hadBom } = decodeHtml(originalBytes);
    const tDecode = performance.now();

    const format = formatForPath(filePath) ?? 'html';
    let doc: RedraDoc;
    let mdState: MdState | undefined;
    let stampedHtml: string;
    if (format === 'md') {
      const parsed = parseMd(text, path.basename(filePath));
      stampedHtml = parsed.stampedHtml;
      mdState = parsed.state;
      doc = EMPTY_HTML_DOC(); // unused for md (see the placeholder note above)
    } else {
      doc = parseDocument(text);
      stampedHtml = serializeForView(doc);
    }
    const tParse = performance.now();
    const tStamp = performance.now();

    const opened: OpenedDoc = {
      docId: randomUUID(),
      filePath: path.resolve(filePath),
      dir: path.dirname(path.resolve(filePath)),
      format,
      doc,
      mdState,
      journal: new Journal(),
      originalBytes,
      encoding,
      hadBom,
      stampedHtml,
      lastKnownMtimeMs: stat.mtimeMs,
      backupDone: false,
      restoredFromBackup: false,
      isUntitled: false,
      cloneCounter: 0,
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

  /**
   * New document (⌘N): an in-memory untitled Markdown doc. No disk read — the
   * starter source is a single empty heading with a localized placeholder.
   * `placeholderPath` is only a placeholder for the title (its basename) and
   * the Save-As default location; nothing is written until the first save.
   */
  openUntitled(placeholderPath: string, headingPlaceholder: string): { opened: OpenedDoc } {
    const resolved = path.resolve(placeholderPath);
    const title = path.basename(resolved);
    const { stampedHtml, state } = newUntitledMd(title, headingPlaceholder);
    const opened: OpenedDoc = {
      docId: randomUUID(),
      filePath: resolved,
      dir: path.dirname(resolved),
      format: 'md',
      doc: EMPTY_HTML_DOC(),
      mdState: state,
      journal: new Journal(),
      originalBytes: Buffer.from(state.mdDoc.source, 'utf8'),
      encoding: 'utf-8',
      hadBom: false,
      stampedHtml,
      lastKnownMtimeMs: 0, // no file on disk yet
      backupDone: true, // nothing to back up — there is no original file
      restoredFromBackup: false,
      isUntitled: true,
      cloneCounter: 0,
    };
    this.current = opened;
    return { opened };
  }

  /** Drop the document (it dies with its window — see the 'closed' handler). */
  close(): void {
    this.current = null;
  }

  /**
   * Version-history restore: re-open the CURRENT document from a backup
   * file. The document path does NOT change — only its content is replaced
   * by the backup bytes; the next ⌘S writes them to the original path.
   *
   * Restore flow, in order:
   *  1. read the backup bytes (a missing/corrupt backup aborts before
   *     anything else happens);
   *  2. snapshot the CURRENT disk bytes into the backup store — the restore
   *     itself must be undoable (this intentionally ignores the
   *     backupOnFirstSave setting: restoring is exactly the moment backups
   *     exist for, and the feature only runs when the store is wired);
   *  3. re-stat the file so the later save does not false-conflict;
   *  4. swap in the parsed document with restoredFromBackup set (dirty until
   *     saved; ops-free save WRITES instead of skipping).
   *
   * `expectedDocId` guards against a stale restore: the menu flow awaits
   * several dialogs, and the user may open a DIFFERENT document meanwhile —
   * applying document A's backup to document B would corrupt B. The caller
   * passes the docId it captured BEFORE any dialog; a mismatch aborts before
   * anything (snapshot included) happens.
   */
  async openFromBackup(backupPath: string, expectedDocId?: string): Promise<{ opened: OpenedDoc }> {
    const cur = this.current;
    if (!cur) throw new Error('Документ не открыт');
    if (expectedDocId !== undefined && cur.docId !== expectedDocId) {
      throw new Error('restore aborted: the open document changed');
    }
    const filePath = cur.filePath;

    const originalBytes = await fs.readFile(backupPath);

    const diskBytes = await fs.readFile(filePath).catch(() => null);
    if (diskBytes && this.backupWriter) {
      await this.backupWriter(filePath, diskBytes);
    }
    const st = await fs.stat(filePath).catch(() => null);

    const { text, encoding, hadBom } = decodeHtml(originalBytes);
    let doc: RedraDoc;
    let mdState: MdState | undefined;
    let stampedHtml: string;
    if (cur.format === 'md') {
      const parsed = parseMd(text, path.basename(filePath));
      stampedHtml = parsed.stampedHtml;
      mdState = parsed.state;
      doc = EMPTY_HTML_DOC();
    } else {
      doc = parseDocument(text);
      stampedHtml = serializeForView(doc);
    }

    const opened: OpenedDoc = {
      docId: randomUUID(),
      filePath,
      dir: cur.dir,
      format: cur.format,
      doc,
      mdState,
      journal: new Journal(),
      originalBytes,
      encoding,
      hadBom,
      stampedHtml,
      lastKnownMtimeMs: st?.mtimeMs ?? cur.lastKnownMtimeMs,
      backupDone: true, // the pre-restore snapshot above IS this session's backup
      restoredFromBackup: true,
      isUntitled: false, // restore only ever runs on an already-saved document
      cloneCounter: 0, // fresh document state — fresh journal, fresh mint
    };
    this.current = opened;
    return { opened };
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

    // An untitled doc has no real path — a plain ⌘S must become Save As so the
    // caller can prompt for a location (the save flow does this via effective
    // Save-As; this guard also protects any direct save() call).
    if (cur.isUntitled && asPath === undefined) return { ok: false, needsPath: true };

    const t0 = performance.now();
    const targetPath = path.resolve(asPath ?? cur.filePath);
    const overwritesCurrent = targetPath === cur.filePath;
    const ops = cur.journal.ops;

    // Save (not Save As) with no edits onto the same file: disk already holds
    // originalBytes — skip the write. HTML: no ops AND a clean journal (a
    // dirty journal with no ops = edit → save → undo-all means disk holds the
    // EDITED bytes, so we must fall through and write originalBytes back).
    // MD 2.0: no committed live body and no dirty flag (edits never enter the
    // journal — keying this on ops would silently skip every md save). A
    // restored backup always writes: disk holds the PRE-restore bytes.
    const mdTouched = cur.format === 'md' && !!(cur.mdState?.liveBody !== null || cur.mdState?.liveDirty);
    const htmlTouched = ops.length > 0 || cur.journal.dirty;
    if (
      asPath === undefined &&
      !(cur.format === 'md' ? mdTouched : htmlTouched) &&
      !cur.restoredFromBackup
    ) {
      this.perf.record('save-skipped-noop', performance.now() - t0);
      return { ok: true, path: targetPath, skipped: true };
    }

    // Conflict guard: someone changed the file since we opened / last saved it.
    // An untitled doc's first write has no "since we opened" baseline (we never
    // opened it) — the OS Save dialog already confirmed any overwrite — so the
    // guard would only mis-fire on a stale file sitting at the placeholder path.
    if (overwritesCurrent && !cur.isUntitled) {
      const st = await fs.stat(targetPath).catch(() => null);
      if (st && st.mtimeMs !== cur.lastKnownMtimeMs) {
        return { ok: false, conflict: true };
      }
    }

    try {
      if (overwritesCurrent && this.backupEnabled && !cur.backupDone && this.backupWriter) {
        try {
          await this.backupWriter(targetPath, cur.originalBytes);
        } catch (err) {
          // The raw fs message alone ("EACCES: ...") would land in the
          // save-error dialog with no hint that it was the BACKUP that
          // failed, not the save itself — prefix it.
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Не удалось создать резервную копию: ${msg}`);
        }
        cur.backupDone = true;
      }

      // With ops the serialized string is written as utf-8 (TextEncoder/Buffer
      // cannot produce legacy encodings). If the file was decoded from another
      // encoding, its <meta charset> would now lie — rewrite it to utf-8.
      // Same for BOM files: the BOM (which won at decode, possibly over a
      // lying meta) is not re-emitted, so the meta must tell the truth.
      let bytes: Buffer;
      if (cur.format === 'md' && cur.mdState) {
        // Markdown 2.0: the body-diff serializer over the committed live body
        // (source verbatim when nothing was ever committed). utf-8; no
        // <meta charset> to rewrite (the charset step is HTML-only). NEVER
        // gate this on the journal — md edits do not create ops, and falling
        // into the originalBytes branch would silently discard the session.
        bytes = Buffer.from(serializeMdLive(cur.mdState), 'utf8');
      } else if (ops.length === 0) {
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
      cur.isUntitled = false; // written to disk now — a real file from here on
      cur.journal.markSaved();
      if (cur.mdState) {
        // Keystrokes typed WHILE this save was writing reported a newer
        // generation than the committed body — they are not in the written
        // bytes, so the doc must stay dirty (the re-arm race from the design
        // review). Only a body that caught up with every report clears it.
        cur.mdState.liveDirty = cur.mdState.dirtyGen > cur.mdState.bodyGen;
      }
      cur.restoredFromBackup = false; // the restored state is on disk now
      this.perf.record('save', performance.now() - t0, { bytes: bytes.length });
      return { ok: true, path: targetPath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
