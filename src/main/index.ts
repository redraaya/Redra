import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRedraScheme, installRedraProtocolHandler } from './protocol.js';
import { DocumentManager } from './document-manager.js';
import { BackupStore } from './lib/backups.js';
import { RecentsStore } from './recents-store.js';
import { SettingsStore } from './settings-store.js';
import { buildAppMenu, setBackupMenuChecked, setDocMenuEnabled } from './menu.js';
import { EDITOR_CSS } from './editor-css.js';
import { PerfLog } from './lib/perf.js';
import { senderMatches } from './lib/sender.js';
import { DEFAULT_SETTINGS } from './lib/settings.js';
import { fetchLatestRelease, shouldNotify } from './lib/update-check.js';
import { tildify } from './lib/tildify.js';
import { guardDocPush } from './lib/op-guard.js';
import { createSaveFlow } from './save-flow.js';
import { ScreenshotHarness } from './screenshot.js';
import { SmokeHarness } from './smoke.js';
import type {
  ExportResult,
  OpPushResult,
  OpUndoResult,
  OpenResult,
  RecentEntry,
  SaveResult,
  Settings,
} from '../shared/ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Height of the shell strip above the document view (real design in Stage 4). */
const SHELL_STRIP_HEIGHT = 44;

// --- CLI ----------------------------------------------------------------
// `electron . [--smoke] [file.html]`. With --smoke the app auto-quits with
// code 0 after the document is served (perf lines logged) — for CI smoke runs.
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2);
const SMOKE = cliArgs.includes('--smoke');
const cliFile = cliArgs.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
const shotIdx = cliArgs.indexOf('--screenshot');
const shotPath = shotIdx >= 0 ? (cliArgs[shotIdx + 1] ?? null) : null;

// --- privileged scheme: must happen before app 'ready' -------------------
registerRedraScheme();

const perf = new PerfLog();
const docManager = new DocumentManager(perf);
const smoke = new SmokeHarness(SMOKE, perf, docManager);
const shot = new ScreenshotHarness(shotPath);
let recents: RecentsStore;
let settingsStore: SettingsStore;
/** Central session backups folder (userData/backups) — set in onReady. */
let backupsDir = '';
/** How many central backups survive a prune. */
const BACKUPS_KEEP = 30;

let win: BrowserWindow | null = null;
let docView: WebContentsView | null = null;
let pendingOpenPath: string | null = cliFile ? path.resolve(cliFile) : null;
/** «Просмотр» state — single source of truth lives here in main. */
let previewOn = false;
/** Set on before-quit so a confirmed close can resume the aborted Cmd+Q. */
let quitRequested = false;

// Save / export / close-guard flows live in save-flow.ts; index only wires.
const saveFlow = createSaveFlow({
  docManager,
  perf,
  smoke: SMOKE,
  getWin: () => win,
  getDocView: () => docView,
  commitActiveEdit,
  isQuitRequested: () => quitRequested,
  clearQuitRequested: () => {
    quitRequested = false;
  },
});

// macOS: dock / Finder "open with"
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady() && win) {
    void openDocument(filePath);
  } else {
    pendingOpenPath = filePath;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});

app.on('before-quit', () => {
  quitRequested = true;
});

void app.whenReady().then(onReady);

async function onReady(): Promise<void> {
  const readyAt = performance.now();
  perf.record('app-start-to-ready', readyAt); // performance.now() origin = process start

  installRedraProtocolHandler((docId) => docManager.getServed(docId));

  recents = new RecentsStore(path.join(app.getPath('userData'), 'recents.json'));
  await recents.load();

  settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  await settingsStore.load();
  docManager.setBackupEnabled(settingsStore.get().backupOnFirstSave);

  // Central backups instead of .bak files next to the user's documents.
  // Existing .bak files are the user's property — never touched or removed.
  backupsDir = path.join(app.getPath('userData'), 'backups');
  const store = new BackupStore(backupsDir);
  docManager.setBackupWriter(async (filePath, bytes) => {
    await store.backupFor(filePath, bytes);
    await store.prune(BACKUPS_KEEP);
  });

  buildAppMenu(
    {
      open: () => void openViaDialog(),
      save: () => void saveFlow.doSave(false),
      saveAs: () => void saveFlow.doSave(true),
      exportPdf: () => void saveFlow.exportPdf(),
      undo: () => docView?.webContents.send('edit:undo'),
      redo: () => docView?.webContents.send('edit:redo'),
      togglePreview: (checked) => setPreview(checked),
      toggleBackup: (checked) => void applySettings({ backupOnFirstSave: checked }),
      showBackups: () => void showBackupsFolder(),
    },
    { backupChecked: settingsStore.get().backupOnFirstSave },
  );
  registerIpc();
  createWindow(readyAt);
  scheduleUpdateCheck();

  // Dev-run dock icon (packaged builds get it from electron-builder in Stage 5).
  if (!app.isPackaged && process.platform === 'darwin') {
    const dockPng = path.join(__dirname, '../../build/icon-512.png');
    if (existsSync(dockPng)) app.dock?.setIcon(dockPng);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(performance.now());
      // open-file may have queued a path while no window existed.
      void drainPendingOpen();
    }
  });

  const pending = drainPendingOpen();
  if (pending) await pending;
  smoke.onReady(pending !== null);
  shot.schedule(
    () => win,
    () => docView,
    pending !== null,
  );
}

/** Open the path queued by 'open-file' while no window existed, if any. */
function drainPendingOpen(): Promise<OpenResult> | null {
  if (!pendingOpenPath) return null;
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return openDocument(p);
}

// --- window + document view ----------------------------------------------

function createWindow(readyAt: number): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#F7F6F3',
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/shell.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setTitle('Redra');

  win.once('ready-to-show', () => {
    win?.show();
    perf.record('ready-to-window-shown', performance.now() - readyAt, {
      sinceProcessStart: performance.now(),
    });
  });

  // Shell renderer never navigates anywhere.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('resize', layoutDocView);
  win.on('close', (event) => {
    if (SMOKE) return;
    if (saveFlow.isCloseFlowActive()) {
      // A second close while the dialog is up must not slip through.
      event.preventDefault();
      return;
    }
    if (!docManager.currentDoc || !win) return;
    // A document is open: even with a clean journal there may be an active
    // edit session (typed text not yet committed) — intercept and go async.
    event.preventDefault();
    void saveFlow.handleCloseRequest(win);
  });
  win.on('closed', () => {
    win = null;
    docView = null;
    // Single-window v1: the document dies with its window. Otherwise a
    // reopened (activate) window would show the start screen while Cmd+S
    // still silently saved the stale document.
    docManager.close();
    setDocMenuEnabled(false);
    setPreview(false);
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function ensureDocView(): WebContentsView {
  if (docView && win) return docView;
  if (!win) throw new Error('no window');

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/doc.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(view);
  docView = view;
  layoutDocView();

  const wc = view.webContents;

  // Editor visuals (hover wash, editing hairline, drag cursor). insertCSS
  // bypasses the page's CSP; dom-ready fires per navigation, so every loaded
  // document gets the sheet. Inserted before first paint of page content in
  // practice — and the classes it styles only appear on user interaction.
  wc.on('dom-ready', () => {
    void wc.insertCSS(EDITOR_CSS).catch((err: unknown) => {
      console.error('[editor] insertCSS failed:', err);
    });
  });

  // Navigation policy: http(s) → external browser; same-doc redra:// root
  // allowed; dropped .html files open in Redra; everything else denied.
  wc.on('will-navigate', (event, url) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      /* deny below */
    }
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      event.preventDefault();
      void shell.openExternal(url);
      return;
    }
    if (parsed && parsed.protocol === 'redra:') {
      const cur = docManager.currentDoc;
      const sameDocRoot = cur && parsed.hostname === 'doc' && parsed.pathname === `/${cur.docId}/`;
      if (sameDocRoot) return; // allow (e.g. anchors that re-request the root)
      // Relative links to sibling .html docs are deliberately dead until multi-doc support.
      event.preventDefault();
      return;
    }
    if (parsed && parsed.protocol === 'file:') {
      event.preventDefault();
      // fileURLToPath throws on e.g. file://host/x.html — document content is
      // untrusted, so never let a crafted anchor crash the main process.
      let fsPath: string;
      try {
        fsPath = fileURLToPath(url);
      } catch {
        return; // navigation already prevented
      }
      if (/\.html?$/i.test(fsPath)) void openDocument(fsPath); // file dropped onto the doc view
      return;
    }
    event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  return view;
}

function layoutDocView(): void {
  if (!win || !docView) return;
  const [width, height] = win.getContentSize();
  docView.setBounds({
    x: 0,
    y: SHELL_STRIP_HEIGHT,
    width: width ?? 0,
    height: Math.max(0, (height ?? 0) - SHELL_STRIP_HEIGHT),
  });
}

// --- settings ----------------------------------------------------------------

/** Single entry point for settings changes (IPC and menu): persist + apply. */
async function applySettings(patch: unknown): Promise<Settings> {
  const next = await settingsStore.set(patch);
  docManager.setBackupEnabled(next.backupOnFirstSave);
  setBackupMenuChecked(next.backupOnFirstSave);
  return next;
}

/** «Показать резервные копии»: open userData/backups in Finder (create it first so openPath never fails on a fresh install). */
async function showBackupsFolder(): Promise<void> {
  if (!backupsDir) return;
  await mkdir(backupsDir, { recursive: true }).catch(() => undefined);
  const err = await shell.openPath(backupsDir);
  if (err) console.error('[backups] openPath failed:', err);
}

// --- update check ------------------------------------------------------------

/**
 * One quiet check per launch, ~8s after ready so it never touches the start
 * budget. Offline / API errors stay silent; the shell only hears about a
 * strictly newer release the user has not dismissed.
 */
function scheduleUpdateCheck(): void {
  if (SMOKE) return; // smoke runs are short-lived and must stay network-free
  setTimeout(() => {
    void fetchLatestRelease().then((latest) => {
      if (!latest || !win) return;
      const dismissed = settingsStore.get().dismissedUpdateVersion;
      if (!shouldNotify(app.getVersion(), latest.version, dismissed)) return;
      win.webContents.send('update:available', {
        version: latest.version,
        url: latest.url,
      });
    });
  }, 8000);
}

/** Only the project's own release pages may leave the app via the update pill. */
function isRedraReleaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'github.com' &&
    parsed.pathname.startsWith('/redraaya/Redra/')
  );
}

// --- editing mode + edit-session commit -------------------------------------

/** Toggle «Просмотр»: editing layer off in the doc view, pill in the shell. */
function setPreview(on: boolean): void {
  // Switching INTO preview must not lose an in-flight edit session.
  const finish = (): void => {
    previewOn = on;
    const item = Menu.getApplicationMenu()?.getMenuItemById('view-preview');
    if (item) item.checked = on;
    docView?.webContents.send('mode:set', { editing: !on });
    win?.webContents.send('mode:changed', { editing: !on });
  };
  if (on && !previewOn) void commitActiveEdit().then(finish);
  else finish();
}

/**
 * Ask the doc preload to commit any active edit session and wait for the
 * ack (nonce on 'edit:committed'), at most 1000ms — if the view is gone or
 * unresponsive we proceed anyway rather than wedging the save flow.
 *
 * Ordering invariant: doc→main IPC from one WebContents is delivered in
 * send order, so by the time the 'edit:committed' ack arrives, every
 * ops:push the commit produced has already been received and journaled —
 * the ack doubles as an ordering barrier for in-flight ops:push.
 */
function commitActiveEdit(): Promise<void> {
  const wc = docView?.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve();
  const nonce = randomUUID();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      ipcMain.removeListener('edit:committed', onReply);
      resolve();
    };
    const onReply = (event: IpcMainEvent, replyNonce: unknown): void => {
      if (!senderMatches(event, wc) || replyNonce !== nonce) return;
      done();
    };
    const timer = setTimeout(() => {
      console.warn('[edit] commit ack timed out — proceeding without it');
      done();
    }, 1000);
    ipcMain.on('edit:committed', onReply);
    wc.send('edit:commit', nonce);
  });
}

function broadcastDirty(): void {
  const cur = docManager.currentDoc;
  win?.webContents.send('doc:dirtyChanged', { dirty: cur ? cur.journal.dirty : false });
}

// --- open flow ---------------------------------------------------------------

async function openDocument(filePath: string): Promise<OpenResult> {
  // Menu accelerators must not interleave with the close-guard dialog.
  if (saveFlow.isCloseFlowActive()) return { ok: false, canceled: true };

  // Opening over a dirty document would silently drop its edits — same
  // three-button guard as window close. Smoke runs never open over dirty,
  // but keep them dialog-free by construction.
  if (!SMOKE && win && docManager.currentDoc) {
    // In-flight typed text counts as unsaved — commit it into the journal first.
    await commitActiveEdit();
    const cur = docManager.currentDoc;
    if (cur && cur.journal.dirty) {
      const choice = await saveFlow.askUnsavedChanges(win, path.basename(cur.filePath));
      if (choice === 'cancel') return { ok: false, canceled: true };
      if (choice === 'save') {
        const saved = await saveFlow.doSave(false);
        if (!saved.ok) return { ok: false, canceled: true };
      }
    }
  }

  const t0 = performance.now();
  try {
    const { opened, timings } = await docManager.open(filePath);
    const view = ensureDocView();
    await view.webContents.loadURL(`redra://doc/${opened.docId}/`);
    perf.record('open-to-served', performance.now() - t0, {
      read: timings.readMs,
      decode: timings.decodeMs,
      parse: timings.parseMs,
      stamp: timings.stampMs,
    });

    const name = path.basename(opened.filePath);
    win?.setTitle(`${name} — Redra`);
    setDocMenuEnabled(true);
    win?.webContents.send('doc:opened', { path: opened.filePath, name });
    win?.webContents.send('doc:dirtyChanged', { dirty: opened.journal.dirty });
    // A fresh document always starts in live editing, never in «Просмотр».
    setPreview(false);

    app.addRecentDocument(opened.filePath);
    await recents.add(opened.filePath);

    smoke.onServed(opened.filePath);
    return { ok: true, path: opened.filePath, name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[open] failed:', message);
    if (SMOKE) app.exit(1);
    else if (win) dialog.showErrorBox('Не удалось открыть файл', message);
    return { ok: false, error: message };
  }
}

async function openViaDialog(): Promise<OpenResult> {
  if (!win) return { ok: false, error: 'no window' };
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  const first = result.filePaths[0];
  if (result.canceled || !first) return { ok: false, canceled: true };
  return openDocument(first);
}

// --- IPC -------------------------------------------------------------------

/** True when the invoke came from the shell window's renderer. */
function fromShell(event: IpcMainInvokeEvent): boolean {
  return senderMatches(event, win?.webContents);
}

/** True when the invoke came from the document view's renderer. */
function fromDoc(event: IpcMainInvokeEvent): boolean {
  return senderMatches(event, docView?.webContents);
}

function registerIpc(): void {
  // --- shell channels ---
  ipcMain.handle('dialog:openFile', (event) => {
    if (!fromShell(event)) return { ok: false, error: 'bad sender' } satisfies OpenResult;
    return openViaDialog();
  });
  ipcMain.handle('doc:open', (event, filePath: unknown) => {
    if (!fromShell(event)) return { ok: false, error: 'bad sender' } satisfies OpenResult;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { ok: false, error: 'bad path' } satisfies OpenResult;
    }
    return openDocument(filePath);
  });
  ipcMain.handle('doc:save', (event) => {
    if (!fromShell(event)) return { ok: false, error: 'bad sender' } satisfies SaveResult;
    return saveFlow.doSave(false);
  });
  ipcMain.handle('doc:saveAs', (event) => {
    if (!fromShell(event)) return { ok: false, error: 'bad sender' } satisfies SaveResult;
    return saveFlow.doSave(true);
  });
  ipcMain.handle('doc:exportPdf', (event) => {
    if (!fromShell(event)) return { ok: false, error: 'bad sender' } satisfies ExportResult;
    return saveFlow.exportPdf();
  });
  ipcMain.on('mode:toggle', (event) => {
    if (!senderMatches(event, win?.webContents)) return;
    if (!docManager.currentDoc) return; // no doc — nothing to preview
    setPreview(!previewOn);
  });
  ipcMain.handle('recents:get', (event): RecentEntry[] => {
    if (!fromShell(event)) return [];
    const home = os.homedir();
    return recents.get().map((e) => ({
      ...e,
      name: path.basename(e.path),
      dir: tildify(path.dirname(e.path), home),
    }));
  });
  ipcMain.handle('settings:get', (event) =>
    fromShell(event) ? settingsStore.get() : ({ ...DEFAULT_SETTINGS } satisfies Settings),
  );
  ipcMain.handle('settings:set', (event, patch: unknown) => {
    if (!fromShell(event)) return settingsStore.get();
    return applySettings(patch);
  });
  ipcMain.handle('perf:get', (event) => (fromShell(event) ? perf.all() : []));
  ipcMain.on('update:open', (event, url: unknown) => {
    if (!senderMatches(event, win?.webContents)) return;
    if (typeof url !== 'string' || !isRedraReleaseUrl(url)) return;
    void shell.openExternal(url);
  });
  ipcMain.on('update:dismiss', (event, version: unknown) => {
    if (!senderMatches(event, win?.webContents)) return;
    if (typeof version !== 'string' || version.length === 0) return;
    void applySettings({ dismissedUpdateVersion: version });
  });

  // --- doc-view channels (Stage 3 editing bridge) ---
  // Every ops call carries the docId baked into the sender's URL: the doc
  // view WebContents is reused across documents, so an in-flight invoke from
  // document A must never land in document B's journal (see guardDocPush).
  ipcMain.handle('ops:push', (event, docId: unknown, raw: unknown): OpPushResult => {
    if (!fromDoc(event)) return { ok: false, error: 'bad sender' };
    const cur = docManager.currentDoc;
    if (!cur) return { ok: false, error: 'no document' };
    const checked = guardDocPush(docId, raw, cur.docId, cur.doc, cur.journal.ops);
    if (!checked.ok) {
      console.error('[ops] rejected push:', checked.error);
      return { ok: false, error: checked.error };
    }
    cur.journal.push(checked.op);
    broadcastDirty();
    return { ok: true };
  });
  ipcMain.handle('ops:undo', (event, docId: unknown): OpUndoResult => {
    if (!fromDoc(event)) return { ok: false, dirty: false };
    const cur = docManager.currentDoc;
    if (!cur || docId !== cur.docId) return { ok: false, dirty: cur?.journal.dirty ?? false };
    const ok = cur.journal.undo();
    broadcastDirty();
    return { ok, dirty: cur.journal.dirty };
  });
  ipcMain.handle('ops:redo', (event, docId: unknown): OpUndoResult => {
    if (!fromDoc(event)) return { ok: false, dirty: false };
    const cur = docManager.currentDoc;
    if (!cur || docId !== cur.docId) return { ok: false, dirty: cur?.journal.dirty ?? false };
    const ok = cur.journal.redo();
    broadcastDirty();
    return { ok, dirty: cur.journal.dirty };
  });
  ipcMain.handle('link:openExternal', (event, url: unknown) => {
    if (!fromDoc(event)) return;
    if (typeof url !== 'string') return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    void shell.openExternal(url);
  });
  // Liveness beacon from the doc preload (see doc.ts). Smoke runs treat a
  // missing beacon as failure; outside smoke it is just a perf datapoint.
  ipcMain.on('doc:editorReady', (event) => {
    if (!senderMatches(event, docView?.webContents)) return;
    smoke.onEditorReady();
  });
}
