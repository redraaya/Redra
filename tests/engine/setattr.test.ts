import { describe, expect, it } from 'vitest';
import {
  getElementById,
  parseDocument,
  RedraOpError,
  serializeSource,
  type Element,
  type RedraDoc,
} from '../../src/engine/index.js';
import { serializePristine } from '../../src/engine/serialize.js';

/**
 * setAttr (v1: image replacement). Engine semantics: set/replace ONE
 * attribute on the clone element (append when absent); the only allowed
 * attribute name is 'src' — the engine itself rejects everything else so the
 * journal can never carry surprise attributes into the saved file.
 */

const HTML = `<!DOCTYPE html>
<html><head><title>img fixture</title><style>img { border: 0 }</style></head><body>
<h1 id="t">Title</h1>
<figure id="fig"><img id="pic" src="old.png" alt="старая"><figcaption id="cap">подпись</figcaption></figure>
<img id="bare" alt="без src">
<div id="card"><img id="inner" src="in.png"></div>
</body></html>
`;

function rid(doc: RedraDoc, domId: string): string {
  for (let i = 0; ; i++) {
    const el = getElementById(doc, `r${i}`);
    if (!el) throw new Error(`no element with id="${domId}" in fixture`);
    if (el.attrs.some((a) => a.name === 'id' && a.value === domId)) return `r${i}`;
  }
}

function attrOf(doc: RedraDoc, id: string, name: string): string | undefined {
  const el = getElementById(doc, id) as Element;
  return el.attrs.find((a) => a.name === name)?.value;
}

describe('applyOps setAttr (via serializeSource)', () => {
  it('replaces an existing src, leaving every other byte of the document intact', () => {
    const doc = parseDocument(HTML);
    const out = serializeSource(doc, [
      { type: 'setAttr', id: rid(doc, 'pic'), name: 'src', value: 'data:image/png;base64,AAAA' },
    ]);
    // Byte-stability elsewhere: the output is exactly the pristine
    // serialization with ONLY that attribute value swapped.
    expect(out).toBe(serializePristine(doc).replace('old.png', 'data:image/png;base64,AAAA'));
    expect(out).toContain('alt="старая"'); // other attrs of the img untouched
  });

  it('appends src when the attribute is absent', () => {
    const doc = parseDocument(HTML);
    const out = serializeSource(doc, [
      { type: 'setAttr', id: rid(doc, 'bare'), name: 'src', value: 'new.png' },
    ]);
    const reparsed = parseDocument(out);
    expect(attrOf(reparsed, rid(reparsed, 'bare'), 'src')).toBe('new.png');
    expect(attrOf(reparsed, rid(reparsed, 'bare'), 'alt')).toBe('без src');
  });

  it('the last setAttr wins when the same attribute is set twice', () => {
    const doc = parseDocument(HTML);
    const id = rid(doc, 'pic');
    const out = serializeSource(doc, [
      { type: 'setAttr', id, name: 'src', value: 'first.png' },
      { type: 'setAttr', id, name: 'src', value: 'second.png' },
    ]);
    expect(out).toContain('second.png');
    expect(out).not.toContain('first.png');
  });

  it('undo path: dropping the op from the active list restores the byte-identical original', () => {
    const doc = parseDocument(HTML);
    serializeSource(doc, [
      { type: 'setAttr', id: rid(doc, 'pic'), name: 'src', value: 'edited.png' },
    ]);
    // Journal undo = the op simply leaves the active list; no ops ⇒ verbatim source.
    expect(serializeSource(doc, [])).toBe(HTML);
  });

  it('never mutates the pristine tree', () => {
    const doc = parseDocument(HTML);
    const id = rid(doc, 'pic');
    serializeSource(doc, [{ type: 'setAttr', id, name: 'src', value: 'edited.png' }]);
    expect(attrOf(doc, id, 'src')).toBe('old.png');
  });

  it('rejects any attribute name except src (engine-level whitelist)', () => {
    const doc = parseDocument(HTML);
    for (const name of ['onerror', 'href', 'srcset', 'SRC', 'style']) {
      expect(() =>
        serializeSource(doc, [{ type: 'setAttr', id: rid(doc, 'pic'), name, value: 'x' }]),
      ).toThrow(RedraOpError);
    }
  });

  it('rejects an unknown id', () => {
    const doc = parseDocument(HTML);
    expect(() =>
      serializeSource(doc, [{ type: 'setAttr', id: 'r9999', name: 'src', value: 'x' }]),
    ).toThrow(RedraOpError);
  });

  it('rejects setAttr on an element inside a deleted block', () => {
    const doc = parseDocument(HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'deleteBlock', id: rid(doc, 'card') },
        { type: 'setAttr', id: rid(doc, 'inner'), name: 'src', value: 'x.png' },
      ]),
    ).toThrow(RedraOpError);
  });

  it('rejects setAttr on an element whose subtree was consumed by editText', () => {
    const doc = parseDocument(HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'editText', id: rid(doc, 'fig'), html: 'plain text' },
        { type: 'setAttr', id: rid(doc, 'pic'), name: 'src', value: 'x.png' },
      ]),
    ).toThrow(RedraOpError);
  });

  it('mixes with other ops: setAttr survives a sibling moveBlock', () => {
    const doc = parseDocument(HTML);
    const out = serializeSource(doc, [
      { type: 'setAttr', id: rid(doc, 'pic'), name: 'src', value: 'moved.png' },
      { type: 'moveBlock', id: rid(doc, 'fig'), beforeId: null },
    ]);
    expect(out).toContain('moved.png');
    const reparsed = parseDocument(out);
    // figure is now the LAST element child of body
    const fig = getElementById(reparsed, rid(reparsed, 'fig'))!;
    const body = fig.parentNode as { childNodes: Array<{ nodeName: string }> };
    const elements = body.childNodes.filter((n) => 'tagName' in n);
    expect(elements[elements.length - 1]).toBe(fig);
  });

  it('is JSON-serializable round-trip (ops are data)', () => {
    const doc = parseDocument(HTML);
    const op = { type: 'setAttr', id: rid(doc, 'pic'), name: 'src', value: 'json.png' } as const;
    const wired = JSON.parse(JSON.stringify(op)) as typeof op;
    expect(serializeSource(doc, [wired])).toContain('json.png');
  });
});
