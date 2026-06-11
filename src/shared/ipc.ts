/**
 * IPC contract shared between main, preload and the shell renderer.
 * Types only — no runtime code, no Electron imports.
 *
 * Channels (shell renderer → main, invoke):
 *   'dialog:openFile'  () → OpenResult            — Cmd+O dialog flow
 *   'doc:open'         (path: string) → OpenResult — open a concrete file (drag-and-drop)
 *   'doc:save'         () → SaveResult
 *   'doc:saveAs'       () → SaveResult
 *   'doc:exportPdf'    () → ExportResult          — printToPDF flow (dialog in main)
 *   'recents:get'      () → RecentEntry[]
 *   'settings:get'     () → Settings
 *   'settings:set'     (patch: Partial<Settings>) → Settings
 *   'perf:get'         () → PerfEntry[]
 *
 * Channels (shell renderer → main, send):
 *   'mode:toggle'      ()  — flip «Просмотр»; main stays the single source of truth
 *   'update:open'      (url: string)     — open the release page; main re-checks
 *                                          the url is https://github.com/redraaya/Redra/…
 *   'update:dismiss'   (version: string) — persist dismissedUpdateVersion
 *
 * Channels (doc preload → main, invoke):
 *   'ops:push'          (docId: string, op: Op) → OpPushResult — validate + journal.push
 *   'ops:undo'          (docId: string) → OpUndoResult         — journal.undo
 *   'ops:redo'          (docId: string) → OpUndoResult         — journal.redo
 *   'link:openExternal' (url: string) → void                   — http/https only
 *
 * Every ops call carries the docId from the sender's URL (redra://doc/<docId>/):
 * the doc view WebContents is reused across documents, so main rejects ops
 * whose docId does not match the currently open document — an in-flight
 * invoke from a previous document must never land in the new journal.
 *
 * Channels (doc preload → main, send):
 *   'edit:committed'    (nonce: string)            — ack for 'edit:commit'
 *   'doc:editorReady'   ()                         — editing layer booted (liveness beacon)
 *
 * Events (main → shell renderer):
 *   'doc:opened'        DocOpenedInfo
 *   'doc:dirtyChanged'  DirtyState   — pushed on every ops push/undo/redo/save
 *   'mode:changed'      ModeState    — «Просмотр» toggled
 *   'update:available'  UpdateInfo   — once per launch, ~8s after ready, only
 *                                      when a newer non-dismissed release exists
 *
 * Events (main → doc preload):
 *   'mode:set'          ModeState    — arm/disarm the editing layer
 *   'edit:undo'         ()           — menu Cmd+Z routed to the doc view
 *   'edit:redo'         ()           — menu Cmd+Shift+Z routed to the doc view
 *   'edit:commit'       (nonce: string) — commit any active edit session, then
 *                                         reply on 'edit:committed' with the nonce
 */

/** One recorded perf measurement (see PerfLog in main/lib/perf). */
export interface PerfEntry {
  name: string;
  ms: number;
  /** Date.now() of when the entry was recorded. */
  at: number;
  detail?: Record<string, number>;
}

export type OpenResult =
  | { ok: true; path: string; name: string }
  | { ok: false; canceled?: boolean; error?: string };

export type SaveResult =
  | { ok: true; path: string; skipped?: boolean }
  | { ok: false; canceled?: boolean; conflict?: boolean; error?: string };

export type ExportResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: boolean; error?: string };

/** Shell preferences persisted in userData/settings.json (see main/settings-store). */
export interface Settings {
  /** Shell chrome theme; the document area is always the file's own world. */
  shellTheme: 'system' | 'light' | 'dark';
  /** Write <name>.html.bak with the original bytes on the first overwrite-save. */
  backupOnFirstSave: boolean;
  /** Update-pill version the user dismissed with ✕ — never offer it again. */
  dismissedUpdateVersion?: string;
}

/** One row of the start screen's «Недавние» list (display-ready, built in main). */
export interface RecentEntry {
  path: string;
  /** Basename, e.g. «отчёт.html». */
  name: string;
  /** Containing directory with the home dir shortened to «~». */
  dir: string;
  /** Date.now() of when the file was last opened in Redra (absent for legacy entries). */
  openedAt?: number;
}

export interface DocOpenedInfo {
  path: string;
  name: string;
}

export interface DirtyState {
  dirty: boolean;
}

export interface ModeState {
  /** True when the live editing layer is armed (default); false = «Просмотр». */
  editing: boolean;
}

/** Payload of 'update:available' — a newer release the user has not dismissed. */
export interface UpdateInfo {
  /** Version without the leading «v», e.g. «0.2.0». */
  version: string;
  /** Release page on github.com/redraaya/Redra. */
  url: string;
}

export type OpPushResult = { ok: true } | { ok: false; error: string };

export type OpUndoResult = { ok: boolean; dirty: boolean };

/**
 * Bridge the doc preload uses to talk to main. Stays INSIDE the isolated
 * preload world — never exposed to the page (see src/preload/doc.ts).
 * `op` is the engine's Op type; declared structurally here so shared/ stays
 * free of engine imports. The bridge itself stamps every call with the
 * docId taken from the page URL — callers never pass it.
 */
export interface RedraDocBridge {
  pushOp(op: { type: string; id: string; [extra: string]: unknown }): Promise<OpPushResult>;
  undo(): Promise<OpUndoResult>;
  redo(): Promise<OpUndoResult>;
  openExternal(url: string): void;
}

/** API exposed by the shell preload as window.redra. */
export interface RedraShellApi {
  openFileDialog(): Promise<OpenResult>;
  openPath(path: string): Promise<OpenResult>;
  /** Resolve a dropped File to its filesystem path (webUtils under the hood). */
  pathForFile(file: File): string;
  save(): Promise<SaveResult>;
  saveAs(): Promise<SaveResult>;
  exportPdf(): Promise<ExportResult>;
  /** Flip «Просмотр» — main owns the state and answers with 'mode:changed'. */
  togglePreview(): void;
  getRecents(): Promise<RecentEntry[]>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  getPerf(): Promise<PerfEntry[]>;
  onDocOpened(cb: (info: DocOpenedInfo) => void): void;
  onDirtyChanged(cb: (state: DirtyState) => void): void;
  onModeChanged(cb: (state: ModeState) => void): void;
  onUpdateAvailable(cb: (info: UpdateInfo) => void): void;
  /** Open the release page in the default browser (main validates the url). */
  openUpdate(url: string): void;
  /** Hide the pill forever for this version (persists dismissedUpdateVersion). */
  dismissUpdate(version: string): void;
}
