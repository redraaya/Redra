import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './lib/atomic-write.js';
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings } from './lib/settings.js';
import type { Settings } from '../shared/ipc.js';

/**
 * Tiny JSON settings store (userData/settings.json). Electron-free: pure
 * fs + the sanitize/merge helpers, so it tests like RecentsStore does.
 */
export class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.settings = sanitizeSettings(JSON.parse(raw));
    } catch {
      // Missing or corrupt file → defaults; the next set() rewrites it.
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  get(): Settings {
    return { ...this.settings };
  }

  /** Merge a (untrusted) partial patch, persist, return the result. */
  async set(patch: unknown): Promise<Settings> {
    this.settings = mergeSettings(this.settings, patch);
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeAtomic(this.file, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      console.warn('[settings] failed to persist:', err);
    }
    return this.get();
  }
}
