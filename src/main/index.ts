import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRedraScheme, installRedraProtocolHandler } from './protocol.js';
import { DocumentManager } from './document-manager.js';
import type { BackupWriter } from './document-manager.js';
import { BackupStore } from './lib/backups.js';
import { RecentsStore } from './recents-store.js';
import { SettingsStore } from './settings-store.js';
import { buildAppMenu, setBackupMenuChecked } from './menu.js';
import type { VersionMenuItem } from './menu.js';
import { EDITOR_CSS } from './editor-css.js';
import { PerfLog } from './lib/perf.js';
import { senderMatches } from './lib/sender.js';
import { DEFAULT_SETTINGS } from './lib/settings.js';
import { fetchLatestRelease, shouldNotify } from './lib/update-check.js';
import { makeT, pickLang } from '../shared/i18n.js';
import { tildify } from './lib/tildify.js';
import { guardCloneBlock, guardDocPush } from './lib/op-guard.js';
import { resolveUnsavedBeforeRestore } from './lib/restore-guard.js';
import { getElementById, renderCloneFragment } from '../engine/index.js';
import {
  buildImageDataUri,
  IMAGE_EXTENSIONS,
  isAllowedImagePath,
  MAX_IMAGE_BYTES,
} from './lib/image-data.js';
import { createSaveFlow } from './save-flow.js';
import { ScreenshotHarness } from './screenshot.js';
import { SmokeHarness } from './smoke.js';
import { ContextRegistry, WindowContext, chooseOpenTarget, isFreeForOpen } from './window-context.js';
import type {
  CloneBlockResult,
  ExportResult,
  ImageValueResult,
  OpPushResult,
  OpUndoResult,
  OpenResult,
  RecentEntry,
  SaveResult,
  Settings,
  UpdateInfo,
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

// Redra stores no cookies, passwords or encrypted state, so Chromium's
// OSCrypt "Safe Storage" key in the macOS keychain serves no purpose — and
// for an ad-hoc-signed app it pops a keychain-password prompt on launch
// (the signature isn't a stable trusted identity). On macOS only
// `use-mock-keychain` actually keeps OSCrypt out of the keychain
// (`password-store` is Linux-only and ignored here); it backs Safe Storage
// with an in-memory mock — no prompt, and we persist nothing that needs it.
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('password-store', 'basic'); // harmless; covers a future Linux build

// --- privileged scheme: must happen before app 'ready' -------------------
registerRedraScheme();

const perf = new PerfLog();
/** One window = one document: every live window has a WindowContext here. */
const registry = new ContextRegistry<WindowContext>();
const smoke = new SmokeHarness(
  SMOKE,
  perf,
  // Smoke runs drive a single window — the first (only) context's document.
  () => registry.all()[0]?.docManager.currentDoc ?? null,
);
const shot = new ScreenshotHarness(shotPath);
let recents: RecentsStore;
let settingsStore: SettingsStore;
/** In-memory session shared by all shell windows and doc views (no disk state, no keychain). */
let appSession: Session | null = null;
/** Central session backups folder (userData/backups) — set in onReady. */
let backupsDir = '';
let backupStore: BackupStore | null = null;
/** Wired to BackupStore in onReady; every per-window DocumentManager gets it. */
let backupWriter: BackupWriter | null = null;
/** Prune budget: newest versions kept per document / store-wide. */
const BACKUPS_KEEP_PER_FILE = 10;
const BACKUPS_KEEP_GLOBAL = 100;
/** "Version History" shows at most this many entries. */
const VERSION_MENU_MAX = 10;

let pendingOpenPath: string | null = cliFile ? path.resolve(cliFile) : null;
/** Set on before-quit so a confirmed close can resume the aborted Cmd+Q. */
let quitRequested = false;
/** 'ready-to-window-shown' is a startup metric — recorded for the FIRST window only. */
let firstWindowShown = false;
/** Last update-check result — replayed to windows created after the check. */
let pendingUpdate: UpdateInfo | null = null;
/**
 * UI language: RU on Russian systems, EN otherwise (no override). The real
 * locale is only known after 'ready' — onReady swaps in the right table
 * before any menu or dialog is built.
 */
let t = makeT('en');

// --- context helpers -----------------------------------------------------

/** The context the app menu acts on: the focused window's, if it is ours. */
function focusedCtx(): WindowContext | null {
  const focused = BrowserWindow.getFocusedWindow();
  return focused ? registry.byShellWcId(focused.webContents.id) : null;
}

/** Resolve a shell-channel IPC sender to its window context (null = reject). */
function shellCtx(event: IpcMainInvokeEvent | IpcMainEvent): WindowContext | null {
  return registry.byShellWcId(event.sender.id);
}

/** Resolve a doc-channel IPC sender to its window context (null = reject). */
function docCtx(event: IpcMainInvokeEvent | IpcMainEvent): WindowContext | null {
  return registry.byDocWcId(event.sender.id);
}

/**
 * Send to a context's SHELL renderer. A window created to host an open may
 * still be loading its shell page — the events that establish the doc state
 * (doc:opened, dirty, mode) must not be lost, so they are deferred to
 * did-finish-load (once-listeners fire in registration order, so the event
 * order is preserved).
 */
function sendToShell(ctx: WindowContext, channel: string, payload: unknown): void {
  if (ctx.win.isDestroyed()) return;
  const wc = ctx.win.webContents;
  if (wc.isDestroyed()) return;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    });
  } else {
    wc.send(channel, payload);
  }
}

/** Handlers shared by every (re)build of the application menu. All doc-bound
 * actions resolve the FOCUSED window's context at click time. */
const menuHandlers = {
  newWindow: () => {
    createWindowContext();
  },
  open: () => void openViaDialog(),
  save: () => void focusedCtx()?.saveFlow.doSave(false),
  saveAs: () => void focusedCtx()?.saveFlow.doSave(true),
  exportPdf: () => void focusedCtx()?.saveFlow.exportPdf(),
  undo: () => focusedCtx()?.docView?.webContents.send('edit:undo'),
  redo: () => focusedCtx()?.docView?.webContents.send('edit:redo'),
  find: () => {
    const ctx = focusedCtx();
    if (ctx?.docManager.currentDoc) sendToShell(ctx, 'find:open', {});
  },
  togglePreview: (checked: boolean) => {
    const ctx = focusedCtx();
    if (ctx) setPreview(ctx, checked);
  },
  toggleBackup: (checked: boolean) => void applySettings({ backupOnFirstSave: checked }),
  showBackups: () => void showBackupsFolder(),
  restoreVersion: (v: VersionMenuItem) => {
    const ctx = focusedCtx();
    if (ctx) void restoreVersion(ctx, v);
  },
};

/** Monotonic token: rapid focus switches start overlapping rebuilds, and the
 * slowest readdir must not install a menu for a window no longer focused. */
let menuRebuildSeq = 0;

/**
 * (Re)build the whole application menu for the FOCUSED window's state.
 * Electron menus are static once set, and "Version History" is data-driven —
 * so the menu is rebuilt on startup, on focus changes, on document open/
 * close and after every backup write. Cheap: a readdir + template build.
 */
async function rebuildAppMenu(): Promise<void> {
  const token = ++menuRebuildSeq;
  // Startup fallback: the first window may not be focused yet (it shows
  // asynchronously) — with exactly one window there is no ambiguity.
  const ctx = focusedCtx() ?? (registry.size === 1 ? registry.all()[0]! : null);
  const cur = ctx?.docManager.currentDoc ?? null;
  let versions: VersionMenuItem[] = [];
  if (cur && backupStore) {
    const entries = await backupStore.list(cur.filePath).catch(() => []);
    const locale = pickLang(app.getLocale()) === 'ru' ? 'ru-RU' : 'en-US';
    const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    versions = entries.slice(0, VERSION_MENU_MAX).map((e) => {
      const dateLabel = fmt.format(new Date(e.savedAt));
      const kb = Math.max(1, Math.round(e.size / 1024));
      return { label: `${dateLabel} · ${kb} ${t('unit.kb')}`, dateLabel, backupPath: e.path };
    });
  }
  // A newer rebuild raced past this one while the backup list was awaited —
  // its state is fresher; installing ours would clobber it.
  if (token !== menuRebuildSeq) return;
  buildAppMenu(menuHandlers, {
    backupChecked: settingsStore.get().backupOnFirstSave,
    t,
    docOpen: !!cur,
    previewChecked: ctx?.previewOn ?? false,
    versions,
  });
}

/**
 * "Version History" click: guard unsaved edits, confirm, snapshot the current
 * disk state (inside openFromBackup), swap the document content to the
 * chosen version and reload the view. The file on disk is untouched until
 * the user saves — the shell shows the dirty dot, ⌘S writes the restored
 * bytes. `ctx` is the context that was focused at click time — the dialogs
 * below stay parented to ITS window even if focus moves meanwhile.
 */
async function restoreVersion(ctx: WindowContext, v: VersionMenuItem): Promise<void> {
  const w = ctx.win;
  const dm = ctx.docManager;
  if (!dm.currentDoc || w.isDestroyed()) return;
  // Captured BEFORE any await: the dialogs below keep the window alive, so
  // the document could in principle change mid-flow (version restore) —
  // document A's backup must never be restored over document B.
  const expectedDocId = dm.currentDoc.docId;
  // Menu entries are ours, but never read a restore source from outside the store.
  if (!path.resolve(v.backupPath).startsWith(backupsDir + path.sep)) return;
  await commitActiveEdit(ctx);
  // openFromBackup snapshots only the DISK bytes — unsaved journal ops would
  // be discarded silently. Same three-button guard as window close; the
  // restore confirm below still answers its own question.
  const cur = dm.currentDoc;
  if (!cur) return;
  const proceed = await resolveUnsavedBeforeRestore({
    journalDirty: cur.journal.dirty,
    askUnsavedChanges: () => ctx.saveFlow.askUnsavedChanges(w, path.basename(cur.filePath)),
    save: () => ctx.saveFlow.doSave(false),
  });
  if (!proceed) return;
  if (w.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(w, {
    type: 'warning',
    message: t('dialog.restore.message').replace('{date}', v.dateLabel),
    detail: t('dialog.restore.detail'),
    buttons: [t('dialog.restore.confirm'), t('dialog.cancel')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  // Stale-document re-check: three dialogs were awaited above — if this
  // window's document changed meanwhile, this restore belongs to a document
  // that is no longer current. Abort silently (the belt-and-braces check
  // inside openFromBackup would throw the same way).
  if (dm.currentDoc?.docId !== expectedDocId) return;
  try {
    const { opened } = await dm.openFromBackup(v.backupPath, expectedDocId);
    const view = ensureDocView(ctx);
    await view.webContents.loadURL(`redra://doc/${opened.docId}/`);
    setPreview(ctx, false); // restored documents open in live editing, like any open
    // Same event as a fresh open: the shell re-syncs its doc state and resets
    // transient UI (the find bar's stale counter included) for the new content.
    sendToShell(ctx, 'doc:opened', {
      path: opened.filePath,
      name: path.basename(opened.filePath),
    });
    broadcastDirty(ctx);
    void rebuildAppMenu(); // the pre-restore snapshot just added a version
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[restore] failed:', message);
    dialog.showErrorBox(t('error.restoreTitle'), message);
  }
}

// macOS: dock / Finder "open with"
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  // After 'ready' openDocument can always run — it creates a window itself
  // when none is free (the session/protocol exist once onReady finished).
  if (app.isReady()) {
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

  // app.getLocale() is only meaningful after 'ready'.
  t = makeT(pickLang(app.getLocale()));

  // ALL Redra sessions live in memory only (no "persist:" prefix). Redra
  // keeps no cookies, no logins, no site state — and a purely in-memory
  // session means Chromium never creates an on-disk cookie store, never
  // initializes OSCrypt, and therefore never has a reason to touch the
  // macOS keychain. Together with use-mock-keychain above this is the
  // belt-and-braces guarantee that Redra asks for NO system permissions.
  appSession = session.fromPartition('redra-ephemeral');

  // Each docId is served by exactly one window's DocumentManager; closed or
  // replaced documents drop out of the registry lookup and 404, as before.
  installRedraProtocolHandler(appSession.protocol, (docId) =>
    registry.byDocId(docId)?.docManager.getServed(docId),
  );

  recents = new RecentsStore(path.join(app.getPath('userData'), 'recents.json'));
  await recents.load();

  settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  await settingsStore.load();

  // Central backups instead of .bak files next to the user's documents.
  // Existing .bak files are the user's property — never touched or removed.
  // Timestamped since v0.2.0: each write is a new version (Date.now() is
  // passed HERE — BackupStore itself never reads the clock).
  backupsDir = path.join(app.getPath('userData'), 'backups');
  const store = new BackupStore(backupsDir);
  backupStore = store;
  backupWriter = async (filePath, bytes) => {
    await store.backupFor(filePath, bytes, Date.now());
    await store.prune(BACKUPS_KEEP_PER_FILE, BACKUPS_KEEP_GLOBAL);
    void rebuildAppMenu(); // a new version just appeared in "Version History"
  };

  await rebuildAppMenu();
  registerIpc();
  createWindowContext(readyAt);
  scheduleUpdateCheck();

  // The menu acts on the focused window: doc-only items, the Preview
  // checkbox and "Version History" all follow focus changes.
  app.on('browser-window-focus', () => void rebuildAppMenu());

  // Dev-run dock icon (packaged builds get it from electron-builder in Stage 5).
  if (!app.isPackaged && process.platform === 'darwin') {
    const dockPng = path.join(__dirname, '../../build/icon-512.png');
    if (existsSync(dockPng)) app.dock?.setIcon(dockPng);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindowContext();
      // open-file may have queued a path while no window existed.
      void drainPendingOpen();
    }
  });

  const pending = drainPendingOpen();
  if (pending) await pending;
  smoke.onReady(pending !== null);
  shot.schedule(
    () => registry.all()[0]?.win ?? null,
    () => registry.all()[0]?.docView ?? null,
    pending !== null,
  );
}

/** Open the path queued by 'open-file' while the app was not ready yet, if any. */
function drainPendingOpen(): Promise<OpenResult> | null {
  if (!pendingOpenPath) return null;
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return openDocument(p);
}

// --- window + document view ----------------------------------------------

/**
 * Create a new window with its own context (start screen until a document
 * opens into it). On macOS all Redra windows share a tabbingIdentifier, so
 * the system decides whether a new window appears as a separate window or as
 * a native tab (System Settings → Desktop & Dock → "Prefer tabs"), and the
 * stock Window-menu items (merge/move/show tab bar) work via role:windowMenu.
 */
function createWindowContext(readyAt?: number): WindowContext {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#F7F6F3',
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, tabbingIdentifier: 'redra' }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/shell.cjs'),
      session: appSession ?? undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setTitle('Redra');

  // One DocumentManager per window: its state IS the per-window document
  // state (OpenedDoc + Journal), so ownership lands where it belongs.
  const dm = new DocumentManager(perf);
  dm.setBackupEnabled(settingsStore.get().backupOnFirstSave);
  dm.setBackupWriter(backupWriter);

  const ctx = new WindowContext(win, dm);
  // Save / export / close-guard flows live in save-flow.ts; every context
  // gets its own instance with context-bound deps (closeFlowActive included).
  ctx.saveFlow = createSaveFlow({
    docManager: dm,
    perf,
    smoke: SMOKE,
    t: (key) => t(key), // forwards to the locale-resolved table (set in onReady)
    getWin: () => (win.isDestroyed() ? null : win),
    getDocView: () => ctx.docView,
    commitActiveEdit: () => commitActiveEdit(ctx),
    isQuitRequested: () => quitRequested,
    clearQuitRequested: () => {
      quitRequested = false;
    },
  });
  registry.add(ctx);

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    if (!firstWindowShown && readyAt !== undefined) {
      firstWindowShown = true;
      perf.record('ready-to-window-shown', performance.now() - readyAt, {
        sinceProcessStart: performance.now(),
      });
    }
  });

  // Shell renderer never navigates anywhere.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('resize', () => layoutDocView(ctx));
  win.on('close', (event) => {
    if (SMOKE) return;
    if (ctx.saveFlow.isCloseFlowActive()) {
      // A second close while the dialog is up must not slip through.
      event.preventDefault();
      return;
    }
    if (!ctx.docManager.currentDoc) return;
    // A document is open: even with a clean journal there may be an active
    // edit session (typed text not yet committed) — intercept and go async.
    // On Cmd+Q Electron fires 'close' per window, so each window runs its
    // own guard; "Cancel" in any dialog aborts the quit (clearQuitRequested)
    // while already-closed windows stay closed — TextEdit behaves the same.
    event.preventDefault();
    void ctx.saveFlow.handleCloseRequest(win);
  });
  win.on('closed', () => {
    // The document dies with its window: drop it so in-flight async flows
    // holding this context see no doc, and the registry stops resolving the
    // docId (protocol → 404) and the IPC sender ids.
    ctx.docManager.close();
    // The doc view is a CHILD view, not the window's own webContents — tear
    // its webContents down explicitly instead of relying on the Electron
    // version's WebContentsView GC behavior.
    const docWc = ctx.docView?.webContents;
    if (docWc && !docWc.isDestroyed()) docWc.close();
    ctx.docView = null;
    registry.remove(ctx);
    void rebuildAppMenu(); // the focused-window state the menu mirrors changed
  });

  // A late window must still show the update pill from this launch's check.
  if (pendingUpdate) sendToShell(ctx, 'update:available', pendingUpdate);

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return ctx;
}

function ensureDocView(ctx: WindowContext): WebContentsView {
  if (ctx.docView) return ctx.docView;
  if (ctx.win.isDestroyed()) throw new Error('no window');

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/doc.cjs'),
      session: appSession ?? undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ctx.win.contentView.addChildView(view);
  ctx.docView = view;
  ctx.docViewWcId = view.webContents.id;
  layoutDocView(ctx);

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

  // Find in document: forward the native match counter to THIS window's
  // shell (the find bar lives there; the search runs in the doc view).
  wc.on('found-in-page', (_event, result) => {
    sendToShell(ctx, 'find:result', {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });

  // A find session does not survive the page it ran in: stop the native
  // search on any real main-frame navigation (doc reload, version restore)
  // so no stale highlights or late found-in-page events leak into the next
  // document state. The shell resets its bar on 'doc:opened' in parallel.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) wc.stopFindInPage('clearSelection');
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
      const cur = ctx.docManager.currentDoc;
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

function layoutDocView(ctx: WindowContext): void {
  if (!ctx.docView || ctx.win.isDestroyed()) return;
  const [width, height] = ctx.win.getContentSize();
  ctx.docView.setBounds({
    x: 0,
    y: SHELL_STRIP_HEIGHT,
    width: width ?? 0,
    height: Math.max(0, (height ?? 0) - SHELL_STRIP_HEIGHT),
  });
}

// --- settings ----------------------------------------------------------------

/** Single entry point for settings changes (IPC and menu): persist + apply
 * to every window's DocumentManager (the setting itself is global). */
async function applySettings(patch: unknown): Promise<Settings> {
  const next = await settingsStore.set(patch);
  for (const ctx of registry.all()) ctx.docManager.setBackupEnabled(next.backupOnFirstSave);
  setBackupMenuChecked(next.backupOnFirstSave);
  return next;
}

/** "Show backups": open userData/backups in Finder (create it first so openPath never fails on a fresh install). */
async function showBackupsFolder(): Promise<void> {
  if (!backupsDir) return;
  await mkdir(backupsDir, { recursive: true }).catch(() => undefined);
  const err = await shell.openPath(backupsDir);
  if (err) console.error('[backups] openPath failed:', err);
}

// --- update check ------------------------------------------------------------

/**
 * One quiet check per launch, ~8s after ready so it never touches the start
 * budget. Offline / API errors stay silent; every shell window shows its own
 * pill (dismiss persists globally, as before); windows created later get the
 * pill on creation via pendingUpdate.
 */
function scheduleUpdateCheck(): void {
  if (SMOKE) return; // smoke runs are short-lived and must stay network-free
  setTimeout(() => {
    void fetchLatestRelease().then((latest) => {
      if (!latest) return;
      const dismissed = settingsStore.get().dismissedUpdateVersion;
      if (!shouldNotify(app.getVersion(), latest.version, dismissed)) return;
      pendingUpdate = { version: latest.version, url: latest.url };
      for (const ctx of registry.all()) sendToShell(ctx, 'update:available', pendingUpdate);
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

/** Toggle Preview for ONE window: editing layer off in its doc view, pill in its shell. */
function setPreview(ctx: WindowContext, on: boolean): void {
  // Switching INTO preview must not lose an in-flight edit session.
  const finish = (): void => {
    ctx.previewOn = on;
    // The View checkbox mirrors the FOCUSED window; for any other window the
    // focus-change rebuild picks the state up later.
    if (ctx === focusedCtx()) {
      const item = Menu.getApplicationMenu()?.getMenuItemById('view-preview');
      if (item) item.checked = on;
    }
    ctx.docView?.webContents.send('mode:set', { editing: !on });
    sendToShell(ctx, 'mode:changed', { editing: !on });
  };
  if (on && !ctx.previewOn) void commitActiveEdit(ctx).then(finish);
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
function commitActiveEdit(ctx: WindowContext): Promise<void> {
  const wc = ctx.docView?.webContents;
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

function broadcastDirty(ctx: WindowContext): void {
  // isDirty covers both journal ops and a restored-but-unsaved backup.
  sendToShell(ctx, 'doc:dirtyChanged', { dirty: ctx.docManager.isDirty() });
}

// --- open flow ---------------------------------------------------------------

/**
 * Route an open (recents click, drop, ⌘O, open-file, CLI):
 *  - the file is already open in some window → focus that window, never a
 *    second copy;
 *  - `prefer` (the shell window the request came from — e.g. a drop onto a
 *    background start screen, which does NOT focus the window) is free →
 *    open into it;
 *  - the focused window shows the start screen → open into it;
 *  - otherwise → a NEW window (a native tab when the system prefers tabs).
 * Opening therefore never replaces a document — the old open-over-dirty
 * guard is gone with the path that needed it.
 */
async function openDocument(filePath: string, prefer?: WindowContext): Promise<OpenResult> {
  const resolved = path.resolve(filePath);

  const already = registry.byDocPath(resolved);
  if (already && !already.win.isDestroyed()) {
    const cur = already.docManager.currentDoc!; // byDocPath implies a doc
    if (already.win.isMinimized()) already.win.restore();
    already.win.show();
    already.win.focus();
    return { ok: true, path: cur.filePath, name: path.basename(cur.filePath) };
  }

  const isFree = (c: WindowContext): boolean =>
    isFreeForOpen({
      hasDoc: !!c.docManager.currentDoc,
      closeFlowActive: c.saveFlow.isCloseFlowActive(),
      opening: c.opening,
    });
  const target =
    prefer && registry.byShellWcId(prefer.shellWcId) === prefer && isFree(prefer)
      ? prefer
      : chooseOpenTarget(focusedCtx(), registry.all(), isFree);
  const ctx = target ?? createWindowContext();
  const createdFresh = target === null;
  // Busy until dm.open + loadURL settle: a second quick open must route to
  // another (or a new) window instead of racing this context's manager.
  ctx.opening = true;

  const t0 = performance.now();
  try {
    const { opened, timings } = await ctx.docManager.open(resolved);
    const view = ensureDocView(ctx);
    await view.webContents.loadURL(`redra://doc/${opened.docId}/`);
    perf.record('open-to-served', performance.now() - t0, {
      read: timings.readMs,
      decode: timings.decodeMs,
      parse: timings.parseMs,
      stamp: timings.stampMs,
    });

    const name = path.basename(opened.filePath);
    if (!ctx.win.isDestroyed()) ctx.win.setTitle(`${name} — Redra`);
    sendToShell(ctx, 'doc:opened', { path: opened.filePath, name });
    broadcastDirty(ctx);
    // A fresh document always starts in live editing, never in Preview.
    setPreview(ctx, false);
    void rebuildAppMenu(); // doc-only items + "Version History" for THIS file

    app.addRecentDocument(opened.filePath);
    await recents.add(opened.filePath);

    smoke.onServed(opened.filePath);
    return { ok: true, path: opened.filePath, name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[open] failed:', message);
    if (SMOKE) app.exit(1);
    else dialog.showErrorBox(t('error.openTitle'), message);
    // A window created just for this open would linger as an unexpected
    // empty window — close it (user-created start screens are kept).
    if (createdFresh && !ctx.win.isDestroyed() && !ctx.docManager.currentDoc) ctx.win.destroy();
    return { ok: false, error: message };
  } finally {
    ctx.opening = false;
  }
}

async function openViaDialog(): Promise<OpenResult> {
  // Parent the dialog to the focused window when there is one; with all
  // windows closed (macOS menu stays alive) the dialog opens unparented.
  const parent = focusedCtx()?.win ?? null;
  const options = {
    properties: ['openFile' as const],
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const first = result.filePaths[0];
  if (result.canceled || !first) return { ok: false, canceled: true };
  return openDocument(first);
}

// --- IPC -------------------------------------------------------------------

function registerIpc(): void {
  // --- shell channels (sender → context via the registry) ---
  ipcMain.handle('dialog:openFile', (event) => {
    if (!shellCtx(event)) return { ok: false, error: 'bad sender' } satisfies OpenResult;
    return openViaDialog();
  });
  ipcMain.handle('doc:open', (event, filePath: unknown) => {
    const ctx = shellCtx(event);
    if (!ctx) return { ok: false, error: 'bad sender' } satisfies OpenResult;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { ok: false, error: 'bad path' } satisfies OpenResult;
    }
    // Drop / recents click: the window the request came from is the natural
    // target when it still shows the start screen (a drop does not focus it).
    return openDocument(filePath, ctx);
  });
  ipcMain.handle('doc:save', (event) => {
    const ctx = shellCtx(event);
    if (!ctx) return { ok: false, error: 'bad sender' } satisfies SaveResult;
    return ctx.saveFlow.doSave(false);
  });
  ipcMain.handle('doc:saveAs', (event) => {
    const ctx = shellCtx(event);
    if (!ctx) return { ok: false, error: 'bad sender' } satisfies SaveResult;
    return ctx.saveFlow.doSave(true);
  });
  ipcMain.handle('doc:exportPdf', (event) => {
    const ctx = shellCtx(event);
    if (!ctx) return { ok: false, error: 'bad sender' } satisfies ExportResult;
    return ctx.saveFlow.exportPdf();
  });
  ipcMain.on('mode:toggle', (event) => {
    const ctx = shellCtx(event);
    if (!ctx?.docManager.currentDoc) return; // no doc — nothing to preview
    setPreview(ctx, !ctx.previewOn);
  });
  // Titlebar undo/redo buttons: route to the sender window's doc view via the
  // SAME events the menu's Cmd+Z / Cmd+Shift+Z send (menuHandlers.undo/redo).
  ipcMain.on('edit:undo', (event) => {
    shellCtx(event)?.docView?.webContents.send('edit:undo');
  });
  ipcMain.on('edit:redo', (event) => {
    shellCtx(event)?.docView?.webContents.send('edit:redo');
  });
  // --- find in document (⌘F, v0.3.0) ---
  // The bar lives in the shell, the search runs on that window's DOC view.
  // NB Electron semantics: findNext:true BEGINS a session, false steps it.
  const MAX_FIND_TEXT = 1024;
  const findTarget = (event: IpcMainEvent): Electron.WebContents | null => {
    const wc = shellCtx(event)?.docView?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  };
  ipcMain.on('find:start', (event, text: unknown) => {
    const wc = findTarget(event);
    if (!wc || typeof text !== 'string' || text.length > MAX_FIND_TEXT) return;
    if (text.length === 0) wc.stopFindInPage('clearSelection');
    else wc.findInPage(text, { findNext: true });
  });
  ipcMain.on('find:next', (event, text: unknown, forward: unknown) => {
    const wc = findTarget(event);
    if (!wc || typeof text !== 'string' || text.length === 0 || text.length > MAX_FIND_TEXT) return;
    wc.findInPage(text, { findNext: false, forward: forward !== false });
  });
  ipcMain.on('find:stop', (event) => {
    findTarget(event)?.stopFindInPage('clearSelection');
  });
  ipcMain.handle('recents:get', (event): RecentEntry[] => {
    if (!shellCtx(event)) return [];
    const home = os.homedir();
    return recents.get().map((e) => ({
      ...e,
      name: path.basename(e.path),
      dir: tildify(path.dirname(e.path), home),
    }));
  });
  ipcMain.handle('settings:get', (event) =>
    shellCtx(event) ? settingsStore.get() : ({ ...DEFAULT_SETTINGS } satisfies Settings),
  );
  ipcMain.handle('settings:set', (event, patch: unknown) => {
    if (!shellCtx(event)) return settingsStore.get();
    return applySettings(patch);
  });
  ipcMain.handle('perf:get', (event) => (shellCtx(event) ? perf.all() : []));
  ipcMain.on('update:open', (event, url: unknown) => {
    if (!shellCtx(event)) return;
    if (typeof url !== 'string' || !isRedraReleaseUrl(url)) return;
    void shell.openExternal(url);
  });
  ipcMain.on('update:dismiss', (event, version: unknown) => {
    if (!shellCtx(event)) return;
    if (typeof version !== 'string' || version.length === 0) return;
    void applySettings({ dismissedUpdateVersion: version });
  });

  // --- doc-view channels (Stage 3 editing bridge) ---
  // The sender resolves to ITS window's context, so an op can only ever land
  // in that window's journal. Every ops call additionally carries the docId
  // baked into the sender's URL: the view is reused across navigations
  // (version restore), so an in-flight invoke from document A must never
  // land in document B's journal (see guardDocPush).
  ipcMain.handle('ops:push', (event, docId: unknown, raw: unknown): OpPushResult => {
    const ctx = docCtx(event);
    if (!ctx) return { ok: false, error: 'bad sender' };
    const cur = ctx.docManager.currentDoc;
    if (!cur) return { ok: false, error: 'no document' };
    const checked = guardDocPush(docId, raw, cur.docId, cur.doc, cur.journal.ops);
    if (!checked.ok) {
      console.error('[ops] rejected push:', checked.error);
      // Localized HERE (main owns the locale); the preload only relays it.
      // 'stale-doc' stays silent on purpose: the op belongs to a document
      // that was replaced — there is nothing the user did wrong just now.
      const userMessage =
        checked.code === 'blocked-subtree'
          ? t('notice.blockedBlock')
          : checked.code === 'invalid'
            ? t('notice.opRejected')
            : undefined;
      return { ok: false, error: checked.error, code: checked.code, userMessage };
    }
    cur.journal.push(checked.op);
    broadcastDirty(ctx);
    return { ok: true };
  });
  // Block duplication: mint + validate + render + push in ONE invoke, so the
  // cloneId can never race another mint. The fragment is rendered BEFORE the
  // journal push — if the engine rejects the op for any reason, nothing was
  // recorded and the preload inserts nothing.
  ipcMain.handle('ops:cloneBlock', (event, docId: unknown, targetId: unknown): CloneBlockResult => {
    const ctx = docCtx(event);
    if (!ctx) return { ok: false, error: 'bad sender' };
    const cur = ctx.docManager.currentDoc;
    if (!cur) return { ok: false, error: 'no document' };
    const cloneId = `c${cur.cloneCounter + 1}`;
    const checked = guardCloneBlock(docId, targetId, cloneId, cur.docId, cur.doc, cur.journal.ops);
    if (!checked.ok) {
      console.error('[ops] rejected cloneBlock:', checked.error);
      const userMessage =
        checked.code === 'blocked-subtree'
          ? t('notice.blockedBlock')
          : checked.code === 'invalid'
            ? t('notice.opRejected')
            : undefined;
      return { ok: false, error: checked.error, code: checked.code, userMessage };
    }
    let html: string;
    try {
      html = renderCloneFragment(cur.doc, cur.journal.ops, checked.op.id, cloneId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ops] cloneBlock render failed:', message);
      return { ok: false, error: message, code: 'invalid', userMessage: t('notice.opRejected') };
    }
    cur.cloneCounter += 1;
    cur.journal.push(checked.op);
    broadcastDirty(ctx);
    return { ok: true, cloneId, html };
  });
  // A rejected push the preload rolled back: forward main's own localized
  // text to the OWNING window's shell as a transient toast. Length-capped
  // defense in depth — the doc preload only ever echoes a userMessage main
  // produced above.
  ipcMain.on('ops:rejected-notice', (event, message: unknown) => {
    const ctx = docCtx(event);
    if (!ctx) return;
    if (typeof message !== 'string' || message.length === 0 || message.length > 500) return;
    sendToShell(ctx, 'notice:show', { text: message });
  });
  // Undo/redo availability from the doc preload → this window's shell, so the
  // titlebar undo/redo buttons can enable/disable in step with the editing layer.
  ipcMain.on('edit:availability', (event, state: unknown) => {
    const ctx = docCtx(event);
    if (!ctx) return;
    if (typeof state !== 'object' || state === null) return;
    const { canUndo, canRedo } = state as Record<string, unknown>;
    if (typeof canUndo !== 'boolean' || typeof canRedo !== 'boolean') return;
    sendToShell(ctx, 'edit:availability', { canUndo, canRedo });
  });
  ipcMain.handle('ops:undo', (event, docId: unknown): OpUndoResult => {
    const ctx = docCtx(event);
    if (!ctx) return { ok: false, dirty: false };
    const cur = ctx.docManager.currentDoc;
    if (!cur || docId !== cur.docId) return { ok: false, dirty: cur?.journal.dirty ?? false };
    const ok = cur.journal.undo();
    broadcastDirty(ctx);
    return { ok, dirty: cur.journal.dirty };
  });
  ipcMain.handle('ops:redo', (event, docId: unknown): OpUndoResult => {
    const ctx = docCtx(event);
    if (!ctx) return { ok: false, dirty: false };
    const cur = ctx.docManager.currentDoc;
    if (!cur || docId !== cur.docId) return { ok: false, dirty: cur?.journal.dirty ?? false };
    const ok = cur.journal.redo();
    broadcastDirty(ctx);
    return { ok, dirty: cur.journal.dirty };
  });
  // --- image replacement (v0.2.0) ---
  // Both channels answer with the value the preload should set as img.src:
  // v1 ALWAYS a base64 data: URI (single-file documents stay self-contained;
  // nothing is copied next to the document). The op itself still arrives via
  // the guarded ops:push — these channels only turn a file into a value.
  ipcMain.handle(
    'image:pick',
    async (event, docId: unknown, id: unknown): Promise<ImageValueResult> => {
      const ctx = docCtx(event);
      if (!ctx) return { ok: false, error: 'bad sender' };
      const guard = guardImageRequest(ctx, docId, id);
      if (guard) return guard;
      if (ctx.win.isDestroyed()) return { ok: false, canceled: true };
      const result = await dialog.showOpenDialog(ctx.win, {
        properties: ['openFile'],
        filters: [{ name: t('dialog.imagesFilter'), extensions: [...IMAGE_EXTENSIONS] }],
      });
      const first = result.filePaths[0];
      if (result.canceled || !first) return { ok: false, canceled: true };
      return imageValueFromFile(first);
    },
  );
  ipcMain.handle(
    'image:fromPath',
    async (event, docId: unknown, id: unknown, filePath: unknown): Promise<ImageValueResult> => {
      const ctx = docCtx(event);
      if (!ctx) return { ok: false, error: 'bad sender' };
      const guard = guardImageRequest(ctx, docId, id);
      if (guard) return guard;
      if (typeof filePath !== 'string' || filePath.length === 0) {
        return { ok: false, error: 'bad path' };
      }
      if (!isAllowedImagePath(filePath)) {
        dialog.showErrorBox(t('error.imageTitle'), t('image.badType'));
        return { ok: false, error: 'not an image' };
      }
      return imageValueFromFile(filePath);
    },
  );
  ipcMain.handle('link:openExternal', (event, url: unknown) => {
    if (!docCtx(event)) return;
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
    if (!docCtx(event)) return;
    smoke.onEditorReady();
  });
}

/**
 * Shared image:pick / image:fromPath gate: docId + target element, which
 * must be an <img> — same rule validateOp enforces for the setAttr op, so
 * a compromised preload cannot use these channels to read files on behalf
 * of a non-image element. Null = ok.
 */
function guardImageRequest(ctx: WindowContext, docId: unknown, id: unknown): ImageValueResult | null {
  const cur = ctx.docManager.currentDoc;
  if (!cur || docId !== cur.docId) return { ok: false, error: 'stale document' };
  const el = typeof id === 'string' ? getElementById(cur.doc, id) : undefined;
  if (!el) return { ok: false, error: 'unknown element' };
  if (el.tagName !== 'img') return { ok: false, error: 'target is not an <img>' }; // parse5 tagNames are lowercase
  return null;
}

/** Read + size-cap + embed. User-visible failures get a dialog right here. */
async function imageValueFromFile(filePath: string): Promise<ImageValueResult> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error(`not a file: ${filePath}`);
    if (st.size > MAX_IMAGE_BYTES) {
      dialog.showErrorBox(t('error.imageTitle'), t('image.tooBig'));
      return { ok: false, error: 'too big' };
    }
    const bytes = await readFile(filePath);
    return { ok: true, value: buildImageDataUri(filePath, bytes) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[image] failed:', message);
    dialog.showErrorBox(t('error.imageTitle'), message);
    return { ok: false, error: message };
  }
}
