import { describe, expect, it } from 'vitest';
import { decodeHtml, detectEncoding, sniffMetaCharset } from '../../src/main/lib/encoding.js';

describe('detectEncoding / decodeHtml', () => {
  it('decodes plain utf-8 without BOM', () => {
    const buf = Buffer.from('<!doctype html><p>Привет</p>', 'utf8');
    const res = decodeHtml(buf);
    expect(res.encoding).toBe('utf-8');
    expect(res.hadBom).toBe(false);
    expect(res.text).toContain('Привет');
  });

  it('strips a utf-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>hi</p>', 'utf8')]);
    const res = decodeHtml(buf);
    expect(res.hadBom).toBe(true);
    expect(res.encoding).toBe('utf-8');
    expect(res.text).toBe('<p>hi</p>');
    expect(res.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('decodes utf-16le with BOM', () => {
    const buf = Buffer.from('\ufeff<p>мир</p>', 'utf16le');
    const res = decodeHtml(buf);
    expect(res.hadBom).toBe(true);
    expect(res.encoding).toBe('utf-16le');
    expect(res.text).toBe('<p>мир</p>');
  });

  it('respects <meta charset=windows-1251>', () => {
    const head = Buffer.from('<html><head><meta charset="windows-1251"></head><body>', 'latin1');
    // "Привет" in cp1251
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const tail = Buffer.from('</body></html>', 'latin1');
    const res = decodeHtml(Buffer.concat([head, cp1251, tail]));
    expect(res.encoding).toBe('windows-1251');
    expect(res.text).toContain('Привет');
  });

  it('supports the http-equiv content-type form', () => {
    const html = '<meta http-equiv="Content-Type" content="text/html; charset=KOI8-R">';
    expect(sniffMetaCharset(Buffer.from(html, 'latin1'))).toBe('koi8-r');
  });

  it('BOM wins over a contradicting meta charset', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<meta charset="windows-1251"><p>Ёж</p>', 'utf8'),
    ]);
    const res = decodeHtml(buf);
    expect(res.encoding).toBe('utf-8');
    expect(res.text).toContain('Ёж');
  });

  it('falls back to utf-8 for unknown charset labels', () => {
    const buf = Buffer.from('<meta charset="not-a-charset"><p>ok</p>', 'utf8');
    const det = detectEncoding(buf);
    expect(det.encoding).toBe('not-a-charset'); // detection reports the label…
    const res = decodeHtml(buf);
    expect(res.encoding).toBe('utf-8'); // …but decoding falls back
    expect(res.text).toContain('ok');
  });

  it('ignores accept-charset on a <form> (only <meta> tags count)', () => {
    const noMeta = '<form accept-charset="koi8-r"><input></form>';
    expect(sniffMetaCharset(Buffer.from(noMeta, 'latin1'))).toBeNull();
    expect(decodeHtml(Buffer.from(noMeta, 'latin1')).encoding).toBe('utf-8');

    const withMeta = noMeta + '<meta charset="windows-1251">';
    expect(sniffMetaCharset(Buffer.from(withMeta, 'latin1'))).toBe('windows-1251');
  });

  it('ignores a charset mention inside a comment', () => {
    const html = '<!-- generator: legacy-cms, charset=koi8-r --><p>ok</p>';
    expect(sniffMetaCharset(Buffer.from(html, 'latin1'))).toBeNull();
    expect(decodeHtml(Buffer.from(html, 'latin1')).encoding).toBe('utf-8');
  });

  it('only sniffs the first 1024 bytes', () => {
    const padding = '<!-- ' + 'x'.repeat(1100) + ' -->';
    const buf = Buffer.from(padding + '<meta charset="windows-1251">', 'latin1');
    expect(sniffMetaCharset(buf)).toBeNull();
  });
});
