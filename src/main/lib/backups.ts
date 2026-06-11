import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic-write.js';

/**
 * Central session backups: instead of littering the user's folders with
 * `<name>.html.bak` next to every edited file, the ORIGINAL bytes of a
 * document go to one app-owned directory (main wires it to
 * userData/backups). Pure fs — tmpdir-testable, no Electron imports.
 */
export class BackupStore {
  constructor(private readonly dir: string) {}

  /**
   * Backup file name: `<basename>.<hash8>.orig.html`, where hash8 is the
   * first 8 hex chars of sha256 over the FULL source path — same-named
   * files from different folders never collide, and the name stays
   * human-findable by the original basename.
   */
  backupPathFor(filePath: string): string {
    const hash8 = createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 8);
    return path.join(this.dir, `${path.basename(filePath)}.${hash8}.orig.html`);
  }

  /**
   * Write the original bytes of `filePath` into the store (atomic), return
   * the backup path. An existing backup for the same path is OVERWRITTEN:
   * each session's first overwrite-save refreshes the backup with THAT
   * session's pre-edit bytes (same semantics the old `.bak` files had).
   * Per-session "only the first save backs up" gating is the caller's job
   * (DocumentManager's backupDone flag).
   */
  async backupFor(filePath: string, bytes: Buffer): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.backupPathFor(filePath);
    await writeAtomic(target, bytes);
    return target;
  }

  /** Remove the oldest backups (by mtime) beyond the newest `keep`. */
  async prune(keep = 30): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const entries: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.orig.html')) continue;
      const file = path.join(this.dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (st?.isFile()) entries.push({ file, mtimeMs: st.mtimeMs });
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    for (const { file } of entries.slice(Math.max(0, keep))) {
      await fs.unlink(file).catch(() => undefined);
    }
  }
}
