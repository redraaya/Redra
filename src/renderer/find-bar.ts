/**
 * Pure state model of the titlebar find bar (⌘F). No DOM, no IPC — methods
 * return the find COMMANDS the shell should send to main, the caller owns
 * the wiring (see main.ts). Kept pure so open/close/counter logic is unit-
 * testable without a window.
 */

/** Mirrors Electron's found-in-page result fields the shell cares about. */
export interface FindResultInfo {
  activeMatchOrdinal: number;
  matches: number;
}

export type FindCommand =
  | { kind: 'start'; text: string }
  | { kind: 'next'; text: string; forward: boolean }
  | { kind: 'stop' };

export class FindBarModel {
  private _open = false;
  private _text = '';
  private _result: FindResultInfo | null = null;

  get open(): boolean {
    return this._open;
  }

  get text(): string {
    return this._text;
  }

  /** «3/17» while there is a query with a result, otherwise empty. */
  get counter(): string {
    if (!this._text || !this._result) return '';
    return `${this._result.activeMatchOrdinal}/${this._result.matches}`;
  }

  /** ⌘F / toolbar toggle-on. Re-running a kept query is the caller's call
   *  (it selects the input text); the model just opens. */
  openBar(): void {
    this._open = true;
  }

  /** Esc / ✕ / toolbar toggle-off. The text is kept (macOS convention) —
   *  reopening selects it; the stale counter is dropped. */
  close(): FindCommand[] {
    if (!this._open) return [];
    this._open = false;
    this._result = null;
    return [{ kind: 'stop' }];
  }

  /** Every input edit: restart the search, or stop it on an emptied query. */
  setText(text: string): FindCommand[] {
    this._text = text;
    this._result = null;
    if (!this._open) return [];
    if (text.length === 0) return [{ kind: 'stop' }];
    return [{ kind: 'start', text }];
  }

  /** Enter (forward) / Shift+Enter (back) / chevron buttons. */
  step(forward: boolean): FindCommand[] {
    if (!this._open || this._text.length === 0) return [];
    return [{ kind: 'next', text: this._text, forward }];
  }

  /** 'find:result' from main. Late results after close/clear are ignored. */
  applyResult(result: FindResultInfo): void {
    if (!this._open || this._text.length === 0) return;
    this._result = result;
  }
}
