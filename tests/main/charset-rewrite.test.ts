import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureUtf8Charset } from '../../src/main/lib/charset-rewrite.js';
import { DocumentManager } from '../../src/main/document-manager.js';
import { PerfLog } from '../../src/main/lib/perf.js';
import { getElementId } from '../../src/engine/index.js';
import { walkElements } from '../../src/engine/parse.js';
import type { Element } from '../../src/engine/index.js';

describe('ensureUtf8Charset', () => {
  it('rewrites <meta charset> in double quotes', () => {
    const html = '<html><head><meta charset="windows-1251"><title>t</title></head><body></body></html>';
    expect(ensureUtf8Charset(html)).toBe(
      '<html><head><meta charset="utf-8"><title>t</title></head><body></body></html>',
    );
  });

  it('rewrites <meta charset> in single quotes', () => {
    expect(ensureUtf8Charset("<head><meta charset='koi8-r'></head>")).toBe(
      '<head><meta charset="utf-8"></head>',
    );
  });

  it('rewrites unquoted <meta charset>', () => {
    expect(ensureUtf8Charset('<head><meta charset=windows-1251></head>')).toBe(
      '<head><meta charset="utf-8"></head>',
    );
  });

  it('rewrites uppercase and self-closing variants', () => {
    expect(ensureUtf8Charset('<head><META CHARSET="WINDOWS-1251"/></head>')).toBe(
      '<head><META charset="utf-8"/></head>',
    );
  });

  it('rewrites with weird spacing around =', () => {
    expect(ensureUtf8Charset('<head><meta   charset =   "windows-1251" ></head>')).toBe(
      '<head><meta   charset="utf-8" ></head>',
    );
    expect(ensureUtf8Charset('<head><meta charset\t=\twindows-1251></head>')).toBe(
      '<head><meta charset="utf-8"></head>',
    );
  });

  it('rewrites the http-equiv content-type form, preserving the rest of content', () => {
    const html =
      '<head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"></head>';
    expect(ensureUtf8Charset(html)).toBe(
      '<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>',
    );
  });

  it('http-equiv form: keeps extra content parameters after the charset', () => {
    const html =
      '<head><meta content="text/html; charset=cp1251; foo=bar" http-equiv="content-type"></head>';
    expect(ensureUtf8Charset(html)).toBe(
      '<head><meta content="text/html; charset=utf-8; foo=bar" http-equiv="content-type"></head>',
    );
  });

  it('does not touch charset mentions outside meta tags', () => {
    const html =
      '<html><head><meta charset="windows-1251"></head><body><p>use charset=koi8-r or &lt;meta charset="x"&gt;</p></body></html>';
    const out = ensureUtf8Charset(html);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('use charset=koi8-r or &lt;meta charset="x"&gt;');
  });

  it('does not touch a meta whose content merely mentions charset (no http-equiv)', () => {
    const html = '<head><meta charset="cp866"><meta name="description" content="about charset=foo"></head>';
    const out = ensureUtf8Charset(html);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('content="about charset=foo"');
  });

  it('inserts <meta charset="utf-8"> after <head> when no declaration exists', () => {
    expect(ensureUtf8Charset('<html><head><title>t</title></head><body></body></html>')).toBe(
      '<html><head><meta charset="utf-8"><title>t</title></head><body></body></html>',
    );
  });

  it('inserts after a <head> that has attributes', () => {
    expect(ensureUtf8Charset('<html><head lang="ru" ><title>t</title></head></html>')).toBe(
      '<html><head lang="ru" ><meta charset="utf-8"><title>t</title></head></html>',
    );
  });

  it('returns the input unchanged when there is no declaration and no <head>', () => {
    const html = '<p>привет</p>';
    expect(ensureUtf8Charset(html)).toBe(html);
  });

  it('rewrites a declaration even beyond the first 1024 chars', () => {
    const pad = '<!-- ' + 'x'.repeat(1500) + ' -->';
    const html = `<html><head>${pad}<meta charset="windows-1251"></head><body></body></html>`;
    const out = ensureUtf8Charset(html);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).not.toContain('windows-1251');
  });

  it('does not insert a second meta when a declaration already says utf-8', () => {
    const html = '<html><head><meta charset="utf-8"></head><body></body></html>';
    const out = ensureUtf8Charset(html);
    expect(out).toBe(html);
    expect(out.match(/<meta/gi)?.length).toBe(1);
  });

  it('is idempotent', () => {
    const inputs = [
      '<html><head><meta charset="windows-1251"></head><body></body></html>',
      '<head><meta charset=KOI8-R></head>',
      '<head><meta http-equiv="Content-Type" content="text/html; charset=cp1251"></head>',
      '<html><head><title>t</title></head></html>',
      '<p>no head</p>',
    ];
    for (const html of inputs) {
      const once = ensureUtf8Charset(html);
      expect(ensureUtf8Charset(once)).toBe(once);
    }
  });
});

describe('DocumentManager: save of an edited windows-1251 file', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'redra-cp1251-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Encode an ASCII+Russian string as windows-1251 bytes (tiny manual map). */
  function cp1251Bytes(text: string): Buffer {
    const map: Record<string, number> = {
      П: 0xcf, р: 0xf0, и: 0xe8, в: 0xe2, е: 0xe5, т: 0xf2,
      о: 0xee, к: 0xea, а: 0xe0,
    };
    const out: number[] = [];
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (code < 0x80) out.push(code);
      else if (map[ch] !== undefined) out.push(map[ch]!);
      else throw new Error(`no cp1251 mapping for ${ch}`);
    }
    return Buffer.from(out);
  }

  it('re-encodes to utf-8 and rewrites the stale meta charset', async () => {
    const filePath = path.join(tmp, 'doc.html');
    const source =
      '<!doctype html>\n<html><head><meta charset="windows-1251"><title>Привет</title></head>\n' +
      '<body><p>Привет</p></body></html>\n';
    await fs.writeFile(filePath, cp1251Bytes(source));

    const dm = new DocumentManager(new PerfLog());
    const { opened } = await dm.open(filePath);
    expect(opened.encoding).toBe('windows-1251');

    // Find the <p> and replace its children — a real op through the journal.
    let pId: string | undefined;
    walkElements(opened.doc.document, (el: Element) => {
      if (el.tagName === 'p') pId = getElementId(opened.doc, el);
    });
    expect(pId).toBeDefined();
    opened.journal.push({ type: 'editText', id: pId!, html: 'Пока' });

    const res = await dm.save();
    expect(res.ok).toBe(true);

    const bytes = await fs.readFile(filePath);
    // Valid UTF-8 (fatal decoder would throw on cp1251 Cyrillic bytes).
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(text).toContain('charset="utf-8"');
    expect(text).not.toMatch(/charset\s*=\s*["']?windows-1251/i);
    expect(text).toContain('<p>Пока</p>');
    expect(text).toContain('<title>Привет</title>');
  });
});
