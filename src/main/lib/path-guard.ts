import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a URL path (the part after redra://doc/<docId>/) against the
 * opened file's directory, refusing anything that escapes it.
 *
 * Returns the resolved absolute path, or null when the request must be
 * rejected (path traversal, absolute path, malformed encoding, NUL bytes).
 */
export function resolveWithinRoot(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  // Reject absolute paths in both POSIX and Windows notations.
  if (decoded.startsWith('/') || decoded.startsWith('\\')) return null;
  if (/^[a-zA-Z]:/.test(decoded)) return null;

  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, decoded);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * Like resolveWithinRoot, but additionally resolves symlinks: a link inside
 * the doc dir pointing outside of it (assets -> /etc) passes the lexical
 * check yet must not be served.
 *
 * Returns the REAL path when the target exists and stays within the real
 * root; the lexically-validated path when the target does not exist (the
 * caller's readFile then 404s naturally); null on escape or other fs errors.
 */
export async function resolveWithinRootReal(
  rootDir: string,
  urlPath: string,
): Promise<string | null> {
  const lexical = resolveWithinRoot(rootDir, urlPath);
  if (lexical === null) return null;

  let realTarget: string;
  try {
    realTarget = await fs.realpath(lexical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Target (or a path segment) does not exist: serve the lexical path and
    // let readFile produce the 404. Anything else (ELOOP, EACCES…) → refuse.
    return code === 'ENOENT' || code === 'ENOTDIR' ? lexical : null;
  }

  let realRoot: string;
  try {
    realRoot = await fs.realpath(path.resolve(rootDir));
  } catch {
    return null; // the root itself is gone or unresolvable
  }

  // Same prefix-trap-aware containment as the lexical check.
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return realTarget;
}
