/**
 * IPC contract shared between main, preload and the shell renderer.
 * Types only — no runtime code, no Electron imports.
 *
 * Channels (renderer → main, invoke):
 *   'dialog:openFile'  () → OpenResult            — Cmd+O dialog flow
 *   'doc:open'         (path: string) → OpenResult — open a concrete file (drag-and-drop)
 *   'doc:save'         () → SaveResult
 *   'doc:saveAs'       () → SaveResult
 *   'recents:get'      () → string[]
 *   'perf:get'         () → PerfEntry[]
 *
 * Events (main → shell renderer):
 *   'doc:opened'        DocOpenedInfo
 *   'doc:dirtyChanged'  DirtyState   — always { dirty: false } until Stage 3
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
}
