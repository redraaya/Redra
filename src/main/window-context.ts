/**
 * Multi-window model (v0.3.0): one window = one document (or the start
 * screen). Every BrowserWindow gets a WindowContext owning ALL its per-window
 * state — the window, its lazy doc view, its own DocumentManager (and through
 * it the OpenedDoc + Journal), the Preview flag and its own save flow (whose
 * close-guard re-entrancy state therefore is per-window too).
 *
 * The registry is the single source of "which contexts exist" and resolves
 * IPC senders / focused windows / docIds / file paths to a context. It is a
 * pure Map wrapper over a structural interface (no runtime Electron imports)
 * so it stays unit-testable.
 */
import type { BrowserWindow, WebContentsView } from 'electron';
import type { DocumentManager } from './document-manager.js';
import type { SaveFlow } from './save-flow.js';

/** What the registry needs to know about a context (structural, testable). */
export interface ContextLike {
  /** Shell WebContents id — registry key, captured at creation. */
  readonly shellWcId: number;
  /** Doc view WebContents id, once the lazy view exists. */
  readonly docViewWcId: number | null;
  /** docId of the open document, if any. */
  readonly docId: string | null;
  /** Absolute (path.resolve'd) path of the open document, if any. */
  readonly docPath: string | null;
}

/** Per-window state. Built by index.ts; saveFlow is assigned right after the
 * constructor (it needs the context for its bound deps — a benign cycle). */
export class WindowContext implements ContextLike {
  /** Captured eagerly: win.webContents throws after the window is destroyed. */
  readonly shellWcId: number;
  docView: WebContentsView | null = null;
  docViewWcId: number | null = null;
  /** Preview state — single source of truth for THIS window. */
  previewOn = false;
  saveFlow!: SaveFlow;

  constructor(
    readonly win: BrowserWindow,
    readonly docManager: DocumentManager,
  ) {
    this.shellWcId = win.webContents.id;
  }

  get docId(): string | null {
    return this.docManager.currentDoc?.docId ?? null;
  }

  get docPath(): string | null {
    return this.docManager.currentDoc?.filePath ?? null;
  }
}

/**
 * Are two ABSOLUTE paths the same file for "already open in another window"
 * purposes? The default macOS (APFS/HFS+) and Windows file systems are
 * case-insensitive, so /a/B.html and /a/b.html are the same file there;
 * elsewhere the comparison stays exact. Callers pass path.resolve'd input.
 */
export function pathsEqual(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (a === b) return true;
  if (platform === 'darwin' || platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return false;
}

/**
 * Where should a newly opened document go?
 *  - the FOCUSED window, when it is free (start screen, no close dialog up);
 *  - the focused window is busy or shows a document → nowhere: the caller
 *    creates a fresh window (null);
 *  - NO focused window (startup, app inactive, dock open): any free window —
 *    this keeps the CLI/open-file path inside the start-screen window that
 *    onReady just created instead of spawning a duplicate.
 */
export function chooseOpenTarget<C>(
  focused: C | null,
  all: readonly C[],
  isFree: (ctx: C) => boolean,
): C | null {
  if (focused) return isFree(focused) ? focused : null;
  return all.find(isFree) ?? null;
}

/** Live contexts, keyed by the shell WebContents id. */
export class ContextRegistry<C extends ContextLike> {
  private readonly contexts = new Map<number, C>();

  add(ctx: C): void {
    this.contexts.set(ctx.shellWcId, ctx);
  }

  /** True when the context was present (idempotent on double-remove). */
  remove(ctx: C): boolean {
    return this.contexts.delete(ctx.shellWcId);
  }

  get size(): number {
    return this.contexts.size;
  }

  all(): C[] {
    return [...this.contexts.values()];
  }

  /** IPC: shell channels resolve their sender here (unknown sender → null). */
  byShellWcId(id: number): C | null {
    return this.contexts.get(id) ?? null;
  }

  /** IPC: doc channels resolve their sender here (unknown sender → null). */
  byDocWcId(id: number): C | null {
    for (const ctx of this.contexts.values()) {
      if (ctx.docViewWcId !== null && ctx.docViewWcId === id) return ctx;
    }
    return null;
  }

  /** redra:// protocol + stale-op checks: which window serves this docId? */
  byDocId(docId: string): C | null {
    for (const ctx of this.contexts.values()) {
      if (ctx.docId !== null && ctx.docId === docId) return ctx;
    }
    return null;
  }

  /** "Same file already open" lookup. `resolvedPath` must be path.resolve'd. */
  byDocPath(resolvedPath: string, platform: NodeJS.Platform = process.platform): C | null {
    for (const ctx of this.contexts.values()) {
      if (ctx.docPath !== null && pathsEqual(ctx.docPath, resolvedPath, platform)) return ctx;
    }
    return null;
  }
}
