import { protocol } from 'electron';
import { promises as fs } from 'node:fs';
import { mimeForPath } from './lib/mime.js';
import { resolveWithinRootReal } from './lib/path-guard.js';

export const REDRA_SCHEME = 'redra';

export interface ServedDoc {
  dir: string;
  html: string;
}

/**
 * Must run before app 'ready' — privileged scheme registration is only
 * possible at that point. standard + secure so relative URLs resolve and
 * the page is treated as a secure context; supportFetchAPI so the page's
 * own fetch() of sibling resources works.
 */
export function registerRedraScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REDRA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * Install the redra:// handler (call after app 'ready', before any doc loads).
 *   redra://doc/<docId>/                → stamped HTML (utf-8)
 *   redra://doc/<docId>/<relative/path> → file resolved inside the doc's directory
 */
export function installRedraProtocolHandler(getDoc: (docId: string) => ServedDoc | undefined): void {
  protocol.handle(REDRA_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (url.hostname !== 'doc') return notFound();

    const segments = url.pathname.split('/'); // ['', '<docId>', ...rest]
    let docId: string;
    try {
      docId = decodeURIComponent(segments[1] ?? '');
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const doc = getDoc(docId);
    if (!doc) return notFound();

    const rest = segments.slice(2).join('/');
    if (rest === '') {
      // The stamped HTML is a JS string re-encoded as utf-8; the header
      // charset must match the bytes we send (it overrides any stale
      // <meta charset> from the original file).
      return new Response(doc.html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // realpath-aware: a symlink inside the doc dir must not escape it.
    const resolved = await resolveWithinRootReal(doc.dir, rest);
    if (resolved === null) return new Response('Forbidden', { status: 403 });

    try {
      const bytes = await fs.readFile(resolved);
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': mimeForPath(resolved) },
      });
    } catch {
      return notFound();
    }
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}
