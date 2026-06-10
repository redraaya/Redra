import { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRedraScheme, installRedraProtocolHandler } from './protocol.js';
import { DocumentManager } from './document-manager.js';
import { RecentsStore } from './recents-store.js';
import { buildAppMenu } from './menu.js';
import { PerfLog } from './lib/perf.js';
import type { OpenResult, SaveResult } from '../shared/ipc.js';

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

let win: BrowserWindow | null = null;
let docView: WebContentsView | null = null;
let pendingOpenPath: string | null = cliFile ? path.resolve(cliFile) : null;

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

  buildAppMenu({
    open: () => void openViaDialog(),
    save: () => void doSave(false),
    saveAs: () => void doSave(true),
  });
  registerIpc();
  createWindow(readyAt);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(performance.now());
  });

  if (pendingOpenPath) {
    const p = pendingOpenPath;
    pendingOpenPath = null;
    await openDocument(p);
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
      event.preventDefault();
      return;
    }
    if (parsed && parsed.protocol === 'file:') {
      event.preventDefault();
      const fsPath = fileURLToPath(url);
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
    win?.webContents.send('doc:opened', { path: opened.filePath, name });
    // No ops exist until Stage 3, so the doc is always clean — but the wiring matters.
    win?.webContents.send('doc:dirtyChanged', { dirty: false });

    app.addRecentDocument(opened.filePath);
    await recents.add(opened.filePath);

    if (SMOKE) {
      console.log('[smoke] document served:', opened.filePath);
      for (const e of perf.all()) {
        console.log(`[smoke] perf ${e.name} = ${e.ms}ms`, e.detail ?? '');
      }
      setTimeout(() => app.exit(0), 250);
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
    // Placeholder until the real dialog in Stage 4.
    console.warn('[save] conflict: file on disk changed since open/last save');
  }
  return saved;
}

// --- IPC -------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('dialog:openFile', () => openViaDialog());
  ipcMain.handle('doc:open', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { ok: false, error: 'bad path' } satisfies OpenResult;
    }
    return openDocument(filePath);
  });
  ipcMain.handle('doc:save', () => doSave(false));
  ipcMain.handle('doc:saveAs', () => doSave(true));
  ipcMain.handle('recents:get', () => recents.get());
  ipcMain.handle('perf:get', () => perf.all());
}
