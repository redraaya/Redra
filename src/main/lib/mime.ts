/**
 * Tiny extension → MIME map for the redra:// protocol.
 * Pure module: no Electron, no Node imports.
 */

export const DEFAULT_MIME = 'application/octet-stream';

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  md: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

/** MIME type for a file path or name, by extension (case-insensitive). */
export function mimeForPath(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0) return DEFAULT_MIME;
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? DEFAULT_MIME;
}
