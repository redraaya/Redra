import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRedraScheme, installRedraProtocolHandler } from './protocol.js';
import { DocumentManager } from './document-manager.js';
import { RecentsStore } from './recents-store.js';
import { SettingsStore } from './settings-store.js';
import { buildAppMenu, setBackupMenuChecked, setDocMenuEnabled } from './menu.js';
import { EDITOR_CSS } from './editor-css.js';
import { PerfLog } from './lib/perf.js';
import { senderMatches } from './lib/sender.js';
import { tildify } from './lib/tildify.js';
import { validateOp } from './lib/validate-op.js';
import { guardDocPush } from './lib/op-guard.js';
import type {
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

// --- privileged scheme: must happen before app 'ready' -------------------
registerRedraScheme();

const perf = new PerfLog();
const docManager = new DocumentManager(perf);
let recents: RecentsStore;
let settingsStore: SettingsStore;

let win: BrowserWindow | null = null;
let docView: WebContentsView | null = null;
let pendingOpenPath: string | null = cliFile ? path.resolve(cliFile) : null;
/** «Просмотр» state — single source of truth lives here in main. */
let previewOn = false;

// --- smoke gate: the run only succeeds once BOTH the document was served
// AND the doc preload reported the editing layer alive ('doc:editorReady').
let smokeServedAt: number | null = null;
let smokeEditorReady = false;
let smokeFinished = false;

function maybeFinishSmoke(): void {
  if (!SMOKE || smokeFinished || smokeServedAt === null || !smokeEditorReady) return;
  smokeFinished = true;
  for (const e of perf.all()) {
    console.log(`[smoke] perf ${e.name} = ${e.ms}ms`, e.detail ?? '');
  }
  smokeOpsRoundtrip();
  console.log('[smoke] editor ready — OK');
  setTimeout(() => app.exit(0), 100);
}

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

  buildAppMenu(
    {
      open: () => void openViaDialog(),
      save: () => void doSave(false),
      saveAs: () => void doSave(true),
      undo: () => docView?.webContents.send('edit:undo'),
      redo: () => docView?.webContents.send('edit:redo'),
      togglePreview: (checked) => setPreview(checked),
      toggleBackup: (checked) => void applySettings({ backupOnFirstSave: checked }),
    },
    { backupChecked: settingsStore.get().backupOnFirstSave },
  );
  registerIpc();
  createWindow(readyAt);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(performance.now());
      // open-file may have queued a path while no window existed.
      void drainPendingOpen();
    }
  });

  const pending = drainPendingOpen();
  if (pending) {
    await pending;
  } else if (SMOKE) {
    console.error('[smoke] no input file given');
    app.exit(1);
  }

  if (SMOKE) {
    // Fail-safe: never hang CI.
    setTimeout(() => {
      console.error('[smoke] timed out');
      app.exit(1);
    }, 20_000);
  }
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
  win.on('closed', () => {
    win = null;
    docView = null;
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

/** SMOKE-mode self-check: validation + journal round-trip on the real doc. */
function smokeOpsRoundtrip(): void {
  const cur = docManager.currentDoc;
  if (!cur) return;
  const checked = validateOp({ type: 'editText', id: 'r1', html: '<b>smoke</b>' }, cur.doc);
  if (!checked.ok) {
    console.error('[smoke] ops-roundtrip FAILED: validateOp:', checked.error);
    app.exit(1);
    return;
  }
  cur.journal.push(checked.op);
  const dirtyAfterPush = cur.journal.dirty;
  cur.journal.undo();
  if (!dirtyAfterPush || cur.journal.dirty) {
    console.error('[smoke] ops-roundtrip FAILED: dirty flags wrong');
    app.exit(1);
    return;
  }
  console.log('[smoke] ops-roundtrip OK');
}

// --- open / save flows -----------------------------------------------------

async function openDocument(filePath: string): Promise<OpenResult> {
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

    if (SMOKE) {
      console.log('[smoke] document served:', opened.filePath);
      smokeServedAt = performance.now();
      maybeFinishSmoke();
      // The editing layer must report in — a dead doc preload is a failed run.
      setTimeout(() => {
        if (!smokeFinished) {
          console.error('[smoke] FAILED: doc preload never reported editorReady');
          app.exit(1);
        }
      }, 5000);
    }
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

async function doSave(saveAs: boolean): Promise<SaveResult> {
  const cur = docManager.currentDoc;
  if (!cur) return { ok: false, error: 'Документ не открыт' };

  // An active edit session must land in the journal before serialization.
  await commitActiveEdit();

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

  const saved = await docManager.save(asPath);
  if (saved.ok) {
    const name = path.basename(saved.path);
    win?.setTitle(`${name} — Redra`);
    win?.webContents.send('doc:dirtyChanged', { dirty: cur.journal.dirty });
  } else if (saved.conflict) {
    // Placeholder until the real dialog in 4.2.
    console.warn('[save] conflict: file on disk changed since open/last save');
  } else if (!saved.canceled) {
    // Generic failure (apply/serialize/write) — must never be silent.
    const message = saved.error ?? 'неизвестная ошибка';
    console.error('[save] failed:', message);
    if (SMOKE) app.exit(1);
    else dialog.showErrorBox('Не удалось сохранить', message);
  }
  return saved;
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
    return doSave(false);
  });
  ipcMain.handle('doc:saveAs', (event) => {
    if (!fromShell(event)) return { ok: false, error: 'bad sender' } satisfies SaveResult;
    return doSave(true);
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
    fromShell(event) ? settingsStore.get() : ({ shellTheme: 'system', backupOnFirstSave: true } satisfies Settings),
  );
  ipcMain.handle('settings:set', (event, patch: unknown) => {
    if (!fromShell(event)) return settingsStore.get();
    return applySettings(patch);
  });
  ipcMain.handle('perf:get', (event) => (fromShell(event) ? perf.all() : []));

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
    if (smokeServedAt !== null) {
      perf.record('serve-to-editor-ready', performance.now() - smokeServedAt);
    }
    smokeEditorReady = true;
    maybeFinishSmoke();
  });
}
