import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addRecent, sanitizeRecents, sanitizeTimes } from './lib/recents.js';

/**
 * Own recents list (besides app.addRecentDocument): JSON in userData, max 10.
 * Persisted format: { list: string[], times: { [path]: openedAtMs } }.
 * The pre-Stage-4 format (bare string[]) still loads — times start empty.
 */
export class RecentsStore {
  private list: string[] = [];
  private times: Record<string, number> = {};

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(parsed)) {
        this.list = sanitizeRecents(parsed);
        this.times = {};
      } else {
        const obj = (parsed ?? {}) as Record<string, unknown>;
        this.list = sanitizeRecents(obj['list']);
        this.times = sanitizeTimes(obj['times'], this.list);
      }
    } catch {
      this.list = [];
      this.times = {};
    }
  }

  get(): { path: string; openedAt?: number }[] {
    return this.list.map((p) => {
      const at = this.times[p];
      return at === undefined ? { path: p } : { path: p, openedAt: at };
    });
  }

  async add(filePath: string, openedAt: number = Date.now()): Promise<void> {
    this.list = addRecent(this.list, filePath);
    this.times[filePath] = openedAt;
    this.times = sanitizeTimes(this.times, this.list); // prune entries that fell off
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify({ list: this.list, times: this.times }, null, 2));
    } catch (err) {
      console.warn('[recents] failed to persist:', err);
    }
  }
}
