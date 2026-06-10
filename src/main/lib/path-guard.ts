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
