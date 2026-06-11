import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Write to a tmp file in the same directory, then rename over the target.
 * Same-dir tmp keeps the rename on one filesystem (atomic on POSIX).
 */
export async function writeAtomic(targetPath: string, bytes: Buffer | string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${randomUUID().slice(0, 8)}.redra-tmp`);
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, targetPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
