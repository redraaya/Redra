import { describe, expect, it } from 'vitest';
import { DEFAULT_MIME, mimeForPath } from '../../src/main/lib/mime.js';

describe('mimeForPath', () => {
  it('maps common extensions', () => {
    expect(mimeForPath('/a/b/index.html')).toBe('text/html');
    expect(mimeForPath('page.htm')).toBe('text/html');
    expect(mimeForPath('img/chart.png')).toBe('image/png');
    expect(mimeForPath('photo.jpeg')).toBe('image/jpeg');
    expect(mimeForPath('style.css')).toBe('text/css');
    expect(mimeForPath('app.js')).toBe('text/javascript');
    expect(mimeForPath('mod.mjs')).toBe('text/javascript');
    expect(mimeForPath('data.json')).toBe('application/json');
    expect(mimeForPath('logo.svg')).toBe('image/svg+xml');
    expect(mimeForPath('font.woff2')).toBe('font/woff2');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeForPath('CHART.PNG')).toBe('image/png');
    expect(mimeForPath('Index.HTML')).toBe('text/html');
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(mimeForPath('archive.xyz123')).toBe(DEFAULT_MIME);
    expect(mimeForPath('Makefile')).toBe(DEFAULT_MIME);
    expect(mimeForPath('trailingdot.')).toBe(DEFAULT_MIME);
  });

  it('uses only the last extension segment', () => {
    expect(mimeForPath('report.html.bak')).toBe(DEFAULT_MIME);
    expect(mimeForPath('a.min.js')).toBe('text/javascript');
  });
});
