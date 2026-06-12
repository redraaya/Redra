import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic-write.js';

/**
 * Central session backups: instead of littering the user's folders with
 * `<name>.html.bak` next to every edited file, the pre-edit bytes of a
 * document go to one app-owned directory (main wires it to
 * userData/backups). Pure fs — tmpdir-testable, no Electron imports.
 *
 * Since v0.2.0 backups are TIMESTAMPED (one file per session-first save,
 * not one overwritten file per document), which makes them a version
 * history. Legacy v0.1.x un-timestamped `.orig.html` files keep working:
 * list() reports them with the file mtime as savedAt — no migration.
 */

/** One stored version of a document, for the «История версий» menu. */
export interface BackupEntry {
  /** Absolute path of the backup file inside the store. */
  path: string;
  /** When the backup was written (ms since epoch). */
  savedAt: number;
  /** Size in bytes. */
  size: number;
}

const SUFFIX = '.orig.html';
/**
 * `YYYYMMDD-HHmmss` (local time), parsed back by stampToMs. A same-second
 * collision uniquifier (`-2`, `-3`, …) may follow the stamp in file names;
 * stampToMs ignores it — both files report the same savedAt second.
 */
function formatStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function stampToMs(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export class BackupStore {
  constructor(private readonly dir: string) {}

  /**
   * `<basename>.<hash8>` — the per-document key. hash8 is the first 8 hex
   * chars of sha256 over the FULL source path: same-named files from
   * different folders never collide, and the name stays human-findable by
   * the original basename.
   */
  private keyFor(filePath: string): string {
    const hash8 = createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 8);
    return `${path.basename(filePath)}.${hash8}`;
  }

  /**
   * Backup file name: `<basename>.<hash8>.<YYYYMMDD-HHmmss>.orig.html`.
   * The timestamp is an EXPLICIT parameter (main passes Date.now() at the
   * call site) so the naming stays a pure, testable function of its inputs.
   */
  backupPathFor(filePath: string, at: number | Date): string {
    const ms = typeof at === 'number' ? at : at.getTime();
    return path.join(this.dir, `${this.keyFor(filePath)}.${formatStamp(ms)}${SUFFIX}`);
  }

  /**
   * Write the pre-edit bytes of `filePath` into the store (atomic), return
   * the backup path. Each session's first overwrite-save adds a NEW
   * timestamped entry; two writes within the same second do NOT overwrite
   * each other — the second gets a `-2` (`-3`, …) uniquifier before the
   * suffix, so e.g. a restore's safety snapshot never clobbers the version
   * written moments earlier. Per-session "only the first save backs up"
   * gating is the caller's job (DocumentManager's backupDone flag).
   */
  async backupFor(filePath: string, bytes: Buffer, at: number | Date): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const base = this.backupPathFor(filePath, at);
    let target = base;
    for (let n = 2; await fileExists(target); n++) {
      target = `${base.slice(0, -SUFFIX.length)}-${n}${SUFFIX}`;
    }
    await writeAtomic(target, bytes);
    return target;
  }

  /**
   * All stored versions of `filePath`, newest first. Timestamped entries get
   * savedAt from the file NAME; legacy v0.1.x `<base>.<hash8>.orig.html`
   * files get it from their mtime.
   */
  async list(filePath: string): Promise<BackupEntry[]> {
    const key = this.keyFor(filePath);
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const entries: BackupEntry[] = [];
    for (const name of names) {
      const savedAtFromName = parseKeyed(name, key);
      if (savedAtFromName === undefined) continue;
      const file = path.join(this.dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) continue;
      entries.push({ path: file, savedAt: savedAtFromName ?? st.mtimeMs, size: st.size });
    }
    entries.sort((a, b) => b.savedAt - a.savedAt);
    return entries;
  }

  /**
   * Trim the store: keep the newest `perFileKeep` versions of each document,
   * then the newest `globalKeep` files overall. Foreign files (not
   * `*.orig.html`) are never touched.
   */
  async prune(perFileKeep = 10, globalKeep = 100): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    type Item = { file: string; key: string; savedAt: number };
    const items: Item[] = [];
    for (const name of names) {
      const parsed = parseAny(name);
      if (!parsed) continue;
      const file = path.join(this.dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) continue;
      items.push({ file, key: parsed.key, savedAt: parsed.savedAt ?? st.mtimeMs });
    }

    const byKey = new Map<string, Item[]>();
    for (const item of items) {
      const group = byKey.get(item.key);
      if (group) group.push(item);
      else byKey.set(item.key, [item]);
    }

    const doomed: Item[] = [];
    const survivors: Item[] = [];
    for (const group of byKey.values()) {
      group.sort((a, b) => b.savedAt - a.savedAt);
      survivors.push(...group.slice(0, Math.max(0, perFileKeep)));
      doomed.push(...group.slice(Math.max(0, perFileKeep)));
    }
    survivors.sort((a, b) => b.savedAt - a.savedAt);
    doomed.push(...survivors.slice(Math.max(0, globalKeep)));

    for (const { file } of doomed) {
      await fs.unlink(file).catch(() => undefined);
    }
  }
}

/**
 * Match `name` against a specific document key. Returns the savedAt ms for
 * a timestamped entry, null for a legacy entry (caller falls back to
 * mtime), undefined when the name does not belong to the key.
 */
function parseKeyed(name: string, key: string): number | null | undefined {
  if (name === `${key}${SUFFIX}`) return null; // legacy v0.1.x
  const prefix = `${key}.`;
  if (!name.startsWith(prefix) || !name.endsWith(SUFFIX)) return undefined;
  const stamp = name.slice(prefix.length, -SUFFIX.length);
  const ms = stampToMs(stamp);
  return ms === null ? undefined : ms;
}

/** True when `p` exists (any kind of dirent). */
function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/** Parse any store entry into its per-document key + optional name timestamp. */
function parseAny(name: string): { key: string; savedAt: number | null } | null {
  if (!name.endsWith(SUFFIX)) return null;
  const stem = name.slice(0, -SUFFIX.length); // `<base>.<hash8>[.<stamp>[-N]]`
  const m = /^(.+)\.(\d{8}-\d{6}(?:-\d+)?)$/.exec(stem);
  if (m) {
    const ms = stampToMs(m[2]!);
    if (ms !== null) return { key: m[1]!, savedAt: ms };
  }
  return { key: stem, savedAt: null }; // legacy: the whole stem is the key
}
