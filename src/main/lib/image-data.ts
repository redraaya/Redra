import { mimeForPath } from './mime.js';

/**
 * Image replacement (v1): the picked/dropped file is ALWAYS embedded as a
 * base64 data: URI — a single-file document stays self-contained, nothing
 * is copied next to it. Pure helpers: the fs/dialog glue lives in index.ts.
 */

/** User-facing cap on the image FILE size (the data: URI is ~4/3 of this). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Extensions accepted by the picker AND re-validated for drag-and-dropped paths. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'] as const;

const EXTENSION_RE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join('|')})$`, 'i');

/** True when the path's extension is one of the allowed image types. */
export function isAllowedImagePath(filePath: string): boolean {
  return EXTENSION_RE.test(filePath);
}

/** `data:<mime>;base64,…` for the file's bytes (mime by extension). */
export function buildImageDataUri(filePath: string, bytes: Buffer): string {
  return `data:${mimeForPath(filePath)};base64,${bytes.toString('base64')}`;
}
