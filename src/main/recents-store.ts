import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addRecent, sanitizeRecents } from './lib/recents.js';

/** Own recents list (besides app.addRecentDocument): JSON in userData, max 10. */
export class RecentsStore {
  private list: string[] = [];

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.list = sanitizeRecents(JSON.parse(raw));
    } catch {
      this.list = [];
    }
  }

  get(): string[] {
    return [...this.list];
  }

  async add(filePath: string): Promise<void> {
    this.list = addRecent(this.list, filePath);
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.list, null, 2));
    } catch (err) {
      console.warn('[recents] failed to persist:', err);
    }
  }
}
