import { describe, expect, it } from 'vitest';
import {
  buildImageDataUri,
  isAllowedImagePath,
  MAX_IMAGE_BYTES,
} from '../../src/main/lib/image-data.js';

describe('isAllowedImagePath', () => {
  it('accepts the v1 image extensions, case-insensitive', () => {
    for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'f.SVG', 'g.avif']) {
      expect(isAllowedImagePath(p)).toBe(true);
    }
  });

  it('rejects everything else (html, pdf, no extension, trailing dot)', () => {
    for (const p of ['a.html', 'b.pdf', 'c', 'd.', 'e.png.exe', 'f.tiff', 'g.ico', 'h.bmp']) {
      expect(isAllowedImagePath(p)).toBe(false);
    }
  });
});

describe('buildImageDataUri', () => {
  it('builds data:<mime>;base64,… from the file bytes', () => {
    const uri = buildImageDataUri('/tmp/тест.png', Buffer.from([1, 2, 3]));
    expect(uri).toBe('data:image/png;base64,AQID');
  });

  it('maps each allowed extension to its image/* mime', () => {
    const b = Buffer.from('x');
    expect(buildImageDataUri('a.jpg', b).startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(buildImageDataUri('a.jpeg', b).startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(buildImageDataUri('a.webp', b).startsWith('data:image/webp;base64,')).toBe(true);
    expect(buildImageDataUri('a.gif', b).startsWith('data:image/gif;base64,')).toBe(true);
    expect(buildImageDataUri('a.svg', b).startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(buildImageDataUri('a.avif', b).startsWith('data:image/avif;base64,')).toBe(true);
  });

  it('caps at 10 MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});
