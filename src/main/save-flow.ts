import { app, dialog, shell } from 'electron';
import type { BrowserWindow, WebContentsView } from 'electron';
import path from 'node:path';
import { writeAtomic } from './lib/atomic-write.js';
import type { DocumentManager } from './document-manager.js';
import type { PerfLog } from './lib/perf.js';
import type { ExportResult, SaveResult } from '../shared/ipc.js';

export interface SaveFlowDeps {
  docManager: DocumentManager;
  perf: PerfLog;
  /** SMOKE flag: smoke runs are dialog-free and fail hard on save errors. */
  smoke: boolean;
  getWin(): BrowserWindow | null;
  getDocView(): WebContentsView | null;
  /** Flush the doc preload's in-flight edit session into the journal. */
  commitActiveEdit(): Promise<void>;
  /** before-quit was seen: a confirmed close should resume the aborted Cmd+Q. */
  isQuitRequested(): boolean;
  /** Cmd+Q was aborted by «Отмена» — forget it. */
  clearQuitRequested(): void;
}

export interface SaveFlow {
  /** True while the «Сохранить изменения?» close flow runs (re-entrancy guard). */
  isCloseFlowActive(): boolean;
  askUnsavedChanges(w: BrowserWindow, name: string): Promise<'save' | 'discard' | 'cancel'>;
  handleCloseRequest(w: BrowserWindow): Promise<void>;
  doSave(saveAs: boolean, opts?: { fromCloseFlow?: boolean }): Promise<SaveResult>;
  exportPdf(): Promise<ExportResult>;
}

/** Save / export / close-guard flows, extracted from index.ts (pure move). */
export function createSaveFlow(deps: SaveFlowDeps): SaveFlow {
  const { docManager, perf } = deps;

  /** Close-guard re-entrancy: true while the «Сохранить изменения?» flow runs. */
  let closeFlowActive = false;

  /**
   * Shared «Сохранить изменения в «<name>»?» dialog (close guard + open-over-
   * dirty). Returns the user's choice; the caller decides what «save» means.
   */
  async function askUnsavedChanges(
    w: BrowserWindow,
    name: string,
  ): Promise<'save' | 'discard' | 'cancel'> {
    const { response } = await dialog.showMessageBox(w, {
      type: 'warning',
      message: `Сохранить изменения в «${name}»?`,
      buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
      defaultId: 0,
      cancelId: 2,
    });
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  }

  /**
   * Close guard: commit any in-flight edit, then — if the journal is dirty —
   * ask «Сохранить / Не сохранять / Отмена». destroy() bypasses 'close', so the
   * approved path cannot re-trigger the guard.
   */
  async function handleCloseRequest(w: BrowserWindow): Promise<void> {
    closeFlowActive = true;
    let destroyed = false;
    try {
      await deps.commitActiveEdit();
      const cur = docManager.currentDoc;
      if (!cur || !cur.journal.dirty) {
        destroyed = true;
        return;
      }
      const choice = await askUnsavedChanges(w, path.basename(cur.filePath));
      if (choice === 'save') {
        const saved = await doSave(false, { fromCloseFlow: true });
        // Save failed or was canceled (e.g. conflict «Отмена») — keep the window.
        destroyed = saved.ok;
      } else if (choice === 'discard') {
        destroyed = true;
      }
    } finally {
      closeFlowActive = false;
      if (destroyed && !w.isDestroyed()) w.destroy();
      if (destroyed && deps.isQuitRequested()) app.quit();
      if (!destroyed) deps.clearQuitRequested(); // Cmd+Q was aborted by «Отмена»
    }
  }

  async function doSave(saveAs: boolean, opts?: { fromCloseFlow?: boolean }): Promise<SaveResult> {
    // Menu accelerators must not interleave with the close-guard dialog —
    // except the save the close flow itself requested.
    if (closeFlowActive && !opts?.fromCloseFlow) return { ok: false, canceled: true };
    const cur = docManager.currentDoc;
    if (!cur) return { ok: false, error: 'Документ не открыт' };

    // An active edit session must land in the journal before serialization.
    await deps.commitActiveEdit();

    const win = deps.getWin();
    let asPath: string | undefined;
    if (saveAs) {
      if (!win) return { ok: false, error: 'no window' };
      const result = await dialog.showSaveDialog(win, {
        defaultPath: cur.filePath,
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      asPath = result.filePath;
    }

    let saved = await docManager.save(asPath);

    // mtime conflict: someone changed the file on disk since open/last save.
    // Loop: the file can change AGAIN between «Перезаписать» and the retry —
    // re-ask instead of falling into the generic-error branch. Bounded so a
    // pathological writer cannot trap the user in the dialog forever.
    for (let attempt = 0; !saved.ok && saved.conflict && attempt < 3; attempt++) {
      if (deps.smoke || !win) {
        console.warn('[save] conflict: file on disk changed since open/last save');
        return saved;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Файл на диске изменён другой программой',
        detail: 'Перезаписать его версией из Redra? Внешние изменения будут потеряны.',
        buttons: ['Перезаписать', 'Отмена'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return { ok: false, canceled: true };
      await docManager.acceptExternalMtime();
      saved = await docManager.save(asPath);
    }
    if (!saved.ok && saved.conflict) {
      // 3 conflicts in a row — surface a real message, not «неизвестная ошибка».
      saved = { ok: false, error: 'Файл на диске продолжает меняться — сохранение прервано' };
    }

    if (saved.ok) {
      const name = path.basename(saved.path);
      win?.setTitle(`${name} — Redra`);
      win?.webContents.send('doc:dirtyChanged', { dirty: cur.journal.dirty });
    } else if (!saved.canceled) {
      // Generic failure (apply/serialize/write) — must never be silent.
      const message = saved.error ?? 'неизвестная ошибка';
      console.error('[save] failed:', message);
      if (deps.smoke) app.exit(1);
      else dialog.showErrorBox('Не удалось сохранить', message);
    }
    return saved;
  }

  /**
   * «Экспорт в PDF…»: commit the active edit (so no editing chrome prints),
   * ask where, print the live doc view, write atomically, reveal in Finder.
   */
  async function exportPdf(): Promise<ExportResult> {
    const cur = docManager.currentDoc;
    const view = deps.getDocView();
    const win = deps.getWin();
    if (!cur || !view || !win) return { ok: false, error: 'Документ не открыт' };

    await deps.commitActiveEdit();

    const pdfName = path.basename(cur.filePath).replace(/\.html?$/i, '') + '.pdf';
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(path.dirname(cur.filePath), pdfName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

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
      dialog.showErrorBox('Не удалось экспортировать PDF', message);
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
