/**
 * IPC contract shared between main, preload and the shell renderer.
 * Types only — no runtime code, no Electron imports.
 *
 * Channels (shell renderer → main, invoke):
 *   'dialog:openFile'  () → OpenResult            — Cmd+O dialog flow
 *   'doc:open'         (path: string) → OpenResult — open a concrete file (drag-and-drop)
 *   'doc:save'         () → SaveResult
 *   'doc:saveAs'       () → SaveResult
 *   'recents:get'      () → string[]
 *   'perf:get'         () → PerfEntry[]
 *
 * Channels (doc preload → main, invoke):
 *   'ops:push'          (op: Op) → OpPushResult    — validate + journal.push
 *   'ops:undo'          () → OpUndoResult          — journal.undo
 *   'ops:redo'          () → OpUndoResult          — journal.redo
 *   'link:openExternal' (url: string) → void       — http/https only
 *
 * Channels (doc preload → main, send):
 *   'edit:committed'    (nonce: string)            — ack for 'edit:commit'
 *
 * Events (main → shell renderer):
 *   'doc:opened'        DocOpenedInfo
 *   'doc:dirtyChanged'  DirtyState   — pushed on every ops push/undo/redo/save
 *   'mode:changed'      ModeState    — «Просмотр» toggled
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

export type OpPushResult = { ok: true } | { ok: false; error: string };

export type OpUndoResult = { ok: boolean; dirty: boolean };

/**
 * Bridge the doc preload uses to talk to main. Stays INSIDE the isolated
 * preload world — never exposed to the page (see src/preload/doc.ts).
 * `op` is the engine's Op type; declared structurally here so shared/ stays
 * free of engine imports.
 */
export interface RedraDocBridge {
  pushOp(op: { type: string; id: string }): Promise<OpPushResult>;
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
  getRecents(): Promise<string[]>;
  getPerf(): Promise<PerfEntry[]>;
  onDocOpened(cb: (info: DocOpenedInfo) => void): void;
  onDirtyChanged(cb: (state: DirtyState) => void): void;
  onModeChanged(cb: (state: ModeState) => void): void;
}
