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
 *   'mode:toggle'      ()  — flip Preview; main stays the single source of truth
 *   'edit:undo'        ()  — titlebar undo button; main routes to the focused
 *                            window's doc view (same event the menu sends)
 *   'edit:redo'        ()  — titlebar redo button; routed like 'edit:undo'
 *   'tip:show'         (info: TipInfo) — titlebar tooltip hover; main relays to
 *                            the sender's doc view (converting the y into doc-
 *                            view space) so it is drawn OVER the document
 *   'tip:hide'         ()  — the hover ended; relayed to the doc view
 *   'find:start'       (text: string)            — findInPage on the doc view
 *                                                  (new session); empty text stops
 *   'find:next'        (text: string, forward: boolean) — step the active session
 *   'find:stop'        ()                        — stopFindInPage('clearSelection')
 *   'update:open'      (url: string)     — open the release page; main re-checks
 *                                          the url is https://github.com/redraaya/Redra/…
 *   'update:dismiss'   (version: string) — persist dismissedUpdateVersion
 *
 * Channels (doc preload → main, invoke):
 *   'ops:push'          (docId: string, op: Op) → OpPushResult — validate + journal.push
 *   'ops:cloneBlock'    (docId: string, targetId: string) → CloneBlockResult
 *                        — mint cloneId + validate + push in ONE invoke (race-free);
 *                          returns the STAMPED clone fragment for live insertion
 *   'ops:undo'          (docId: string) → OpUndoResult         — journal.undo
 *   'ops:redo'          (docId: string) → OpUndoResult         — journal.redo
 *   'link:openExternal' (url: string) → void                   — http/https only
 *   'image:pick'        (docId: string, id: string) → ImageValueResult
 *                        — open-file dialog → read → base64 data: URI (≤10 MB)
 *   'image:fromPath'    (docId: string, id: string, path: string) → ImageValueResult
 *                        — drag-and-dropped file path; main re-validates the
 *                          extension and size before embedding
 *
 * Every ops call carries the docId from the sender's URL (redra://doc/<docId>/):
 * the doc view WebContents is reused across documents, so main rejects ops
 * whose docId does not match the currently open document — an in-flight
 * invoke from a previous document must never land in the new journal.
 *
 * Channels (doc preload → main, send):
 *   'edit:committed'    (nonce: string)            — ack for 'edit:commit'
 *   'doc:editorReady'   ()                         — editing layer booted (liveness beacon)
 *   'ops:rejected-notice' (message: string)        — a rejected push was rolled back and
 *                                                    deserves a user-visible notice; main
 *                                                    forwards it to the shell as 'notice:show'
 *   'edit:availability' (state: EditAvailability)  — undo/redo availability changed; main
 *                                                    relays it to this window's shell
 *
 * Events (main → shell renderer):
 *   'doc:opened'        DocOpenedInfo
 *   'doc:dirtyChanged'  DirtyState   — pushed on every ops push/undo/redo/save
 *   'mode:changed'      ModeState    — Preview toggled
 *   'notice:show'       NoticeInfo   — transient quiet toast (rejected-op notice)
 *   'find:open'         ()           — menu ⌘F: open the titlebar find bar
 *   'find:result'       FindResult   — found-in-page from the doc view (counter)
 *   'update:available'  UpdateInfo   — once per launch, ~8s after ready, only
 *                                      when a newer non-dismissed release exists
 *   'edit:availability' EditAvailability — relayed from the doc view; drives the
 *                                          titlebar undo/redo buttons' enabled state
 *
 * Events (main → doc preload):
 *   'mode:set'          ModeState    — arm/disarm the editing layer
 *   'edit:undo'         ()           — menu Cmd+Z routed to the doc view
 *   'edit:redo'         ()           — menu Cmd+Shift+Z routed to the doc view
 *   'tip:show'          TipInfo      — draw the titlebar tooltip over the document
 *   'tip:hide'          ()           — hide it
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

import type { DocFormat } from './doc-types.js';

export type OpenResult =
  | { ok: true; path: string; name: string }
  | { ok: false; canceled?: boolean; error?: string };

export type SaveResult =
  | { ok: true; path: string; skipped?: boolean }
  | { ok: false; canceled?: boolean; conflict?: boolean; needsPath?: boolean; error?: string };

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
  /** Last window bounds (getNormalBounds) — new windows open at this size. */
  windowBounds?: { x: number; y: number; width: number; height: number };
  /** The window was maximized — restore that state on top of windowBounds. */
  windowMaximized?: boolean;
}

/** One row of the start screen's "Recent" list (display-ready, built in main). */
export interface RecentEntry {
  path: string;
  /** Basename, e.g. "report.html". */
  name: string;
  /** Containing directory with the home dir shortened to «~». */
  dir: string;
  /** Date.now() of when the file was last opened in Redra (absent for legacy entries). */
  openedAt?: number;
}

export interface DocOpenedInfo {
  path: string;
  name: string;
  /** 'md' shows the markdown-only titlebar actions (Copy for Telegram). */
  format: DocFormat;
}

export interface DirtyState {
  dirty: boolean;
  /** Save is meaningful even when not dirty — an untitled doc needs its first
   *  write. The shell enables the Save button on this, not on `dirty`. */
  canSave: boolean;
}

/** Inline formats the Format menu (keyboard shortcuts) toggles over the current
 *  selection — a subset of the toolbar's actions that need no extra input. Sent
 *  main → doc view as 'edit:format' and applied through the same pipeline as a
 *  toolbar click. */
export type FormatCommand = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler';

export interface ModeState {
  /** True when the live editing layer is armed (default); false = Preview. */
  editing: boolean;
}

/** Payload of 'notice:show' — a transient quiet toast in the shell strip. */
export interface NoticeInfo {
  /** Already-localized text (main owns the locale). */
  text: string;
}

/** Payload of 'find:result' — match counter fields of Electron's found-in-page. */
export interface FindResult {
  /** 1-based position of the active match; 0 when there are no matches. */
  activeMatchOrdinal: number;
  matches: number;
}

/** Payload of 'update:available' — a newer release the user has not dismissed. */
export interface UpdateInfo {
  /** Version without the leading «v», e.g. «0.2.0». */
  version: string;
  /** Release page on github.com/redraaya/Redra. */
  url: string;
}

/**
 * Why an ops:push was rejected — set by the guard (see op-guard.ts):
 *   'stale-doc'       — the push carried another document's id (in-flight
 *                       invoke from a replaced document; dies silently);
 *   'invalid'         — shape/id/value validation failed;
 *   'blocked-subtree' — the target sits inside a subtree already consumed
 *                       by an active editText/deleteBlock.
 */
export type OpRejectCode = 'stale-doc' | 'invalid' | 'blocked-subtree';

/**
 * userMessage is the LOCALIZED, user-facing explanation (main owns the
 * locale); present only for rejections worth a notice — the preload shows
 * it via 'ops:rejected-notice', never composing text of its own.
 */
export type OpPushResult =
  | { ok: true }
  | { ok: false; error: string; code?: OpRejectCode; userMessage?: string };

export type OpUndoResult = { ok: boolean; dirty: boolean };

/**
 * Result of 'ops:cloneBlock': main minted `cloneId`, journaled the op and
 * rendered `html` — the clone subtree STAMPED with data-redra-id (cloneId /
 * cloneId-n), so the preload can insert an immediately-editable live copy.
 * Rejections mirror OpPushResult (codes from the same guard).
 */
export type CloneBlockResult =
  | { ok: true; cloneId: string; html: string }
  | { ok: false; error: string; code?: OpRejectCode; userMessage?: string };

/**
 * Result of 'image:pick' / 'image:fromPath': the value to set as the img's
 * src — v1 ALWAYS a base64 data: URI, so single-file documents stay
 * self-contained. canceled = the user closed the picker; error has already
 * been shown to the user by main (dialog) — the preload just aborts quietly.
 */
export type ImageValueResult =
  | { ok: true; value: string }
  | { ok: false; canceled?: boolean; error?: string };

/**
 * Bridge the doc preload uses to talk to main. Stays INSIDE the isolated
 * preload world — never exposed to the page (see src/preload/doc.ts).
 * `op` is the engine's Op type; declared structurally here so shared/ stays
 * free of engine imports. The bridge itself stamps every call with the
 * docId taken from the page URL — callers never pass it.
 */
export interface RedraDocBridge {
  pushOp(op: { type: string; id: string; [extra: string]: unknown }): Promise<OpPushResult>;
  /** Duplicate block `id`: main mints the cloneId, journals the op and returns the stamped fragment. */
  cloneBlock(id: string): Promise<CloneBlockResult>;
  undo(): Promise<OpUndoResult>;
  redo(): Promise<OpUndoResult>;
  openExternal(url: string): void;
  /** Replace image flow: open-file dialog in main → data: URI for img `id`. */
  pickImage(id: string): Promise<ImageValueResult>;
  /** Replace image from a drag-and-dropped file path → data: URI for img `id`. */
  replaceImageFromPath(id: string, path: string): Promise<ImageValueResult>;
  /** Resolve a dropped File to its filesystem path (webUtils under the hood). */
  pathForFile(file: File): string;
  /** A rejected push was rolled back — surface main's localized message as a shell toast. */
  notifyRejected(message: string): void;
  /** MD 2.0: commit the whole <main> innerHTML at a commit point. `gen` is the
   *  renderer input generation the snapshot captured. Optional so the HTML
   *  path's bridge stubs stay valid unchanged (absent ⇒ html doc). */
  commitMdBody?(docId: string, html: string, gen: number): Promise<{ ok: boolean }>;
  /** MD 2.0: first input of a dirty period — main flips liveDirty/dirtyGen. */
  mdDirty?(docId: string, gen: number): void;
  /** Undo/redo availability changed — main relays it to this window's shell so
   *  the titlebar undo/redo buttons can enable/disable. */
  emitAvailability(state: EditAvailability): void;
}

/**
 * Payload of 'edit:availability' (doc → main → shell): whether the titlebar
 * undo/redo buttons should be shown. There is ONE undo timeline — the journal
 * mirrored by the doc view's local stack; no native contenteditable tier.
 *   canRedo — true ONLY after an undo (cleared by any new edit), so Redo never
 *     appears just because you clicked into a block.
 *   canUndo — true when the journal has history OR the open session has an
 *     un-checkpointed change, so Undo appears the moment you edit something,
 *     but not on a bare click-in.
 */
export interface EditAvailability {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Payload of 'tip:show': the titlebar tooltip text and where to put it. x is
 * the hovered icon's horizontal centre; y is the pill's top edge. Coordinates
 * are in WINDOW-content space when sent by the shell; main converts y into
 * doc-view space (subtracting the strip height) before relaying.
 */
export interface TipInfo {
  text: string;
  x: number;
  y: number;
}

/** API exposed by the shell preload as window.redra. */
export interface RedraShellApi {
  openFileDialog(): Promise<OpenResult>;
  openPath(path: string): Promise<OpenResult>;
  /** ⌘N / start-screen button: create a new untitled Markdown document. */
  newFile(): Promise<OpenResult>;
  /** Resolve a dropped File to its filesystem path (webUtils under the hood). */
  pathForFile(file: File): string;
  save(): Promise<SaveResult>;
  saveAs(): Promise<SaveResult>;
  exportPdf(): Promise<ExportResult>;
  /** Titlebar Telegram button (md only): both clipboard flavors + toast. */
  copyTelegram(): void;
  /** Flip Preview — main owns the state and answers with 'mode:changed'. */
  togglePreview(): void;
  /** Undo/redo the focused window's document — main routes to its doc view
   *  via the SAME 'edit:undo'/'edit:redo' events the menu uses. */
  undo(): void;
  redo(): void;
  /** Undo/redo availability from the doc view, for the titlebar buttons. */
  onEditAvailability(cb: (state: EditAvailability) => void): void;
  /** Titlebar tooltip over the document (window-content coords; main converts
   *  y to doc-view space). Used only when a document is open; on the start
   *  screen the shell draws its own tooltip (no doc view to clear). */
  tipShow(info: TipInfo): void;
  tipHide(): void;
  /** Find in the document (native findInPage on the doc view). */
  findStart(text: string): void;
  findNext(text: string, forward: boolean): void;
  findStop(): void;
  /** Menu ⌘F routed to this window's shell: open the find bar. */
  onFindOpen(cb: () => void): void;
  onFindResult(cb: (result: FindResult) => void): void;
  getRecents(): Promise<RecentEntry[]>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  getPerf(): Promise<PerfEntry[]>;
  onDocOpened(cb: (info: DocOpenedInfo) => void): void;
  /** Path/name changed under an open document (Save As / first save of an
   *  untitled doc) — update the titlebar without a full re-open. */
  onDocRenamed(cb: (info: DocOpenedInfo) => void): void;
  onDirtyChanged(cb: (state: DirtyState) => void): void;
  onModeChanged(cb: (state: ModeState) => void): void;
  onNotice(cb: (notice: NoticeInfo) => void): void;
  onUpdateAvailable(cb: (info: UpdateInfo) => void): void;
  /** Open the release page in the default browser (main validates the url). */
  openUpdate(url: string): void;
  /** Hide the pill forever for this version (persists dismissedUpdateVersion). */
  dismissUpdate(version: string): void;
}
