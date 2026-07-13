import { app, dialog, shell } from 'electron';
import type { BrowserWindow, WebContentsView } from 'electron';
import path from 'node:path';
import { writeAtomic } from './lib/atomic-write.js';
import type { DocumentManager } from './document-manager.js';
import type { PerfLog } from './lib/perf.js';
import type { ExportResult, SaveResult } from '../shared/ipc.js';
import type { Translate } from '../shared/i18n.js';

export interface SaveFlowDeps {
  docManager: DocumentManager;
  perf: PerfLog;
  /** SMOKE flag: smoke runs are dialog-free and fail hard on save errors. */
  smoke: boolean;
  /** Localized dialog strings (resolved in main after app ready). */
  t: Translate;
  getWin(): BrowserWindow | null;
  getDocView(): WebContentsView | null;
  /** Flush the doc preload's in-flight edit into main (journal op for HTML,
   *  whole-body commit for md). Resolves TRUE when the view acked in time —
   *  an md save with unsaved edits must FAIL on a missed ack rather than
   *  silently write a stale body as success. */
  commitActiveEdit(): Promise<boolean>;
  /** before-quit was seen: a confirmed close should resume the aborted Cmd+Q. */
  isQuitRequested(): boolean;
  /** Cmd+Q was aborted by "Cancel" — forget it. */
  clearQuitRequested(): void;
}

export interface SaveFlow {
  /** True while the "Save changes?" close flow runs (re-entrancy guard). */
  isCloseFlowActive(): boolean;
  askUnsavedChanges(w: BrowserWindow, name: string): Promise<'save' | 'discard' | 'cancel'>;
  handleCloseRequest(w: BrowserWindow): Promise<void>;
  doSave(saveAs: boolean, opts?: { fromCloseFlow?: boolean }): Promise<SaveResult>;
  exportPdf(): Promise<ExportResult>;
}

/** Save / export / close-guard flows, extracted from index.ts (pure move). */
export function createSaveFlow(deps: SaveFlowDeps): SaveFlow {
  const { docManager, perf } = deps;

  /** Close-guard re-entrancy: true while the "Save changes?" flow runs. */
  let closeFlowActive = false;

  /**
   * Shared "Save changes to <name>?" dialog (close guard + open-over-
   * dirty). Returns the user's choice; the caller decides what «save» means.
   */
  async function askUnsavedChanges(
    w: BrowserWindow,
    name: string,
  ): Promise<'save' | 'discard' | 'cancel'> {
    const { response } = await dialog.showMessageBox(w, {
      type: 'warning',
      message: deps.t('dialog.unsaved.message').replace('{name}', name),
      buttons: [deps.t('dialog.unsaved.save'), deps.t('dialog.unsaved.discard'), deps.t('dialog.cancel')],
      defaultId: 0,
      cancelId: 2,
    });
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  }

  /**
   * Close guard: commit any in-flight edit, then — if the journal is dirty —
   * ask "Save / Don't Save / Cancel". destroy() bypasses 'close', so the
   * approved path cannot re-trigger the guard.
   */
  async function handleCloseRequest(w: BrowserWindow): Promise<void> {
    closeFlowActive = true;
    let destroyed = false;
    try {
      await deps.commitActiveEdit();
      const cur = docManager.currentDoc;
      // isDirty: journal ops OR a restored-but-unsaved backup version.
      if (!cur || !docManager.isDirty()) {
        destroyed = true;
        return;
      }
      const choice = await askUnsavedChanges(w, path.basename(cur.filePath));
      if (choice === 'save') {
        const saved = await doSave(false, { fromCloseFlow: true });
        // Save failed or was canceled (e.g. conflict "Cancel") — keep the window.
        destroyed = saved.ok;
      } else if (choice === 'discard') {
        destroyed = true;
      }
    } finally {
      closeFlowActive = false;
      if (destroyed && !w.isDestroyed()) w.destroy();
      if (destroyed && deps.isQuitRequested()) app.quit();
      if (!destroyed) deps.clearQuitRequested(); // Cmd+Q was aborted by "Cancel"
    }
  }

  async function doSave(saveAs: boolean, opts?: { fromCloseFlow?: boolean }): Promise<SaveResult> {
    // Menu accelerators must not interleave with the close-guard dialog —
    // except the save the close flow itself requested.
    if (closeFlowActive && !opts?.fromCloseFlow) return { ok: false, canceled: true };
    const cur = docManager.currentDoc;
    if (!cur) return { ok: false, error: deps.t('error.noDocument') };

    // An untitled (⌘N) doc has no file yet, so even a plain ⌘S must prompt for
    // a location — treat it as Save As. The path it lands at is a rename.
    const effectiveSaveAs = saveAs || cur.isUntitled;
    const prevPath = cur.filePath;

    // An active edit session must land in main before serialization.
    const commitAcked = await deps.commitActiveEdit();

    const win = deps.getWin();
    let asPath: string | undefined;
    if (effectiveSaveAs) {
      if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
      const result = await dialog.showSaveDialog(win, {
        defaultPath: cur.filePath,
        filters:
          cur.format === 'md'
            ? [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }]
            : [{ name: 'HTML', extensions: ['html', 'htm'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      asPath = result.filePath;
    }

    // MD 2.0: a dirty document whose commit did NOT arrive means mdState holds
    // a stale (or no) body — writing it would report success while silently
    // discarding the newest edits. Fail loudly; the generic error branch below
    // shows the dialog and keeps the window on the close path.
    let saved: SaveResult;
    if (cur.format === 'md' && !commitAcked && docManager.isDirty()) {
      saved = { ok: false, error: deps.t('error.commitCapture') };
    } else {
      saved = await docManager.save(asPath);
    }

    // mtime conflict: someone changed the file on disk since open/last save.
    // Loop: the file can change AGAIN between "Overwrite" and the retry —
    // re-ask instead of falling into the generic-error branch. Bounded so a
    // pathological writer cannot trap the user in the dialog forever.
    for (let attempt = 0; !saved.ok && saved.conflict && attempt < 3; attempt++) {
      // Re-read the window after every await: a reference captured before save()
      // could point to an already-destroyed window ("Object has been destroyed").
      const w = deps.getWin();
      if (deps.smoke || !w || w.isDestroyed()) {
        console.warn('[save] conflict: file on disk changed since open/last save');
        return saved;
      }
      const { response } = await dialog.showMessageBox(w, {
        type: 'warning',
        message: deps.t('dialog.conflict.message'),
        detail: deps.t('dialog.conflict.detail'),
        buttons: [deps.t('dialog.conflict.overwrite'), deps.t('dialog.cancel')],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return { ok: false, canceled: true };
      await docManager.acceptExternalMtime();
      saved = await docManager.save(asPath);
    }
    if (!saved.ok && saved.conflict) {
      // 3 conflicts in a row — surface a real message, not «unknown error».
      saved = { ok: false, error: deps.t('error.keepsChanging') };
    }

    if (saved.ok) {
      // Re-read the window after await save(): it could have been closed while
      // the write was in flight — setTitle on a dead reference throws.
      const w = deps.getWin();
      if (w && !w.isDestroyed()) {
        const name = path.basename(saved.path);
        w.setTitle(`${name} — Redra`);
        // Save As / an untitled doc's first save changed the path: refresh the
        // shell titlebar name without a full re-open (which would reset find /
        // undo-redo affordances). Byte-path compare is enough here.
        if (saved.path !== prevPath) {
          w.webContents.send('doc:renamed', { path: saved.path, name });
        }
        w.webContents.send('doc:dirtyChanged', {
          dirty: docManager.isDirty(),
          canSave: docManager.canSave(),
        });
      }
    } else if (!saved.canceled) {
      // Generic failure (apply/serialize/write) — must never be silent.
      const message = saved.error ?? deps.t('error.unknown');
      console.error('[save] failed:', message);
      if (deps.smoke) app.exit(1);
      else dialog.showErrorBox(deps.t('error.saveTitle'), message);
    }
    return saved;
  }

  /**
   * "Export to PDF…": commit the active edit (so no editing chrome prints),
   * ask where, print the live doc view, write atomically, reveal in Finder.
   */
  async function exportPdf(): Promise<ExportResult> {
    const cur = docManager.currentDoc;
    if (!cur || !deps.getDocView() || !deps.getWin()) {
      return { ok: false, error: deps.t('error.noDocument') };
    }

    await deps.commitActiveEdit();

    // Re-read the window after the await: a reference captured before it could
    // point to an already-destroyed window ("Object has been destroyed").
    const win = deps.getWin();
    if (!win || win.isDestroyed()) return { ok: false, canceled: true };

    const pdfName = path.basename(cur.filePath).replace(/\.(html?|md|markdown|mdown|mkd)$/i, '') + '.pdf';
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(path.dirname(cur.filePath), pdfName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    // Same for the doc view: the document could have been closed while the dialog was up.
    const view = deps.getDocView();
    if (!view || view.webContents.isDestroyed()) return { ok: false, canceled: true };

    try {
      const t0 = performance.now();
      const data = await view.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      });
      await writeAtomic(result.filePath, data);
      perf.record('export-pdf', performance.now() - t0, { bytes: data.length });
      shell.showItemInFolder(result.filePath);
      return { ok: true, path: result.filePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[pdf] export failed:', message);
      dialog.showErrorBox(deps.t('error.pdfTitle'), message);
      return { ok: false, error: message };
    }
  }

  return {
    isCloseFlowActive: () => closeFlowActive,
    askUnsavedChanges,
    handleCloseRequest,
    doSave,
    exportPdf,
  };
}
