import { describe, expect, it } from 'vitest';
import {
  getElementById,
  parseDocument,
  RedraOpError,
  serializeForView,
  serializeSource,
  type Element,
  type Op,
  type RedraDoc,
} from '../../src/engine/index.js';
import { serializePristine } from '../../src/engine/serialize.js';

/**
 * Fixture with known structure. Body blocks (with whitespace text nodes
 * between them): h1, p#a, p#b, div#c (with a span inside), table with td#cell.
 */
const OPS_HTML = `<!DOCTYPE html>
<html><head><title>Ops fixture</title></head><body>
<h1 id="head1">Title</h1>
<p id="a" class="keep" data-x="1">Alpha</p>
<p id="b">Beta</p>
<div id="c"><span id="inner">inner text</span></div>
<table><tbody><tr><td id="cell">old cell</td><td id="cell2">other</td></tr></tbody></table>
</body></html>
`;

/** Resolve the rN id of the first element matching `pred`, in document order. */
function findId(doc: RedraDoc, pred: (el: Element) => boolean, what: string): string {
  for (let i = 0; ; i++) {
    const el = getElementById(doc, `r${i}`);
    if (!el) throw new Error(`no element matching ${what} in fixture`);
    if (pred(el)) return `r${i}`;
  }
}

/** Resolve the rN id of the element whose HTML id attribute is domId. */
function rid(doc: RedraDoc, domId: string): string {
  return findId(
    doc,
    (el) => el.attrs.some((a) => a.name === 'id' && a.value === domId),
    `id="${domId}"`,
  );
}

/** Resolve the rN id of the first element with the given tag name. */
function tagId(doc: RedraDoc, tagName: string): string {
  return findId(doc, (el) => el.tagName === tagName, `<${tagName}>`);
}

/** Children of <body> in the serialized output, reparsed. */
function bodyChildren(html: string): { tags: string[]; text: string } {
  const doc = parseDocument(html);
  let body: Element | undefined;
  for (let i = 0; ; i++) {
    const el = getElementById(doc, `r${i}`);
    if (!el) break;
    if (el.tagName === 'body') body = el;
  }
  if (!body) throw new Error('no body');
  const tags: string[] = [];
  let text = '';
  for (const child of body.childNodes) {
    if ('tagName' in child) tags.push((child as Element).tagName);
    else if (child.nodeName === '#text') text += (child as { value: string }).value;
  }
  return { tags, text };
}

describe('editText', () => {
  it('replaces the children of a simple paragraph, new inline tags appear', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [
      { type: 'editText', id: rid(doc, 'a'), html: 'New <b>bold</b> and <a href="#x">link</a>' },
    ]);
    expect(out).toContain(
      '<p id="a" class="keep" data-x="1">New <b>bold</b> and <a href="#x">link</a></p>',
    );
    // siblings untouched
    expect(out).toContain('<h1 id="head1">Title</h1>');
    expect(out).toContain('<p id="b">Beta</p>');
    expect(out).toContain('<span id="inner">inner text</span>');
    expect(out).not.toContain('Alpha');
  });

  it('parses html in the context of the target element (td inside a table)', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [
      { type: 'editText', id: rid(doc, 'cell'), html: 'new <i>cell</i> &amp; co' },
    ]);
    expect(out).toContain('<td id="cell">new <i>cell</i> &amp; co</td>');
    expect(out).toContain('<td id="cell2">other</td>');
    expect(out).not.toContain('old cell');
  });

  it('empties an element with html: ""', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [{ type: 'editText', id: rid(doc, 'c'), html: '' }]);
    expect(out).toContain('<div id="c"></div>');
    expect(out).not.toContain('inner text');
    expect(out).not.toContain('<span');
  });
});

describe('deleteBlock', () => {
  it('removes a middle element; siblings join up', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [{ type: 'deleteBlock', id: rid(doc, 'b') }]);
    expect(out).not.toContain('Beta');
    expect(out).not.toContain('id="b"');
    expect(out).toContain('Alpha');
    expect(out).toContain('<div id="c">');
    expect(bodyChildren(out).tags).toEqual(['h1', 'p', 'div', 'table']);
  });

  it('removes the whole subtree of an element with children, no trace remains', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [{ type: 'deleteBlock', id: rid(doc, 'c') }]);
    expect(out).not.toContain('id="c"');
    expect(out).not.toContain('inner');
    expect(out).not.toContain('<span');
    expect(out).toContain('<p id="b">Beta</p>');
  });
});

describe('moveBlock', () => {
  it('moves an element up (before an earlier sibling)', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [
      { type: 'moveBlock', id: rid(doc, 'b'), beforeId: rid(doc, 'a') },
    ]);
    expect(out.indexOf('id="b"')).toBeLessThan(out.indexOf('id="a"'));
    expect(bodyChildren(out).tags).toEqual(['h1', 'p', 'p', 'div', 'table']);
  });

  it('moves an element down (before a later sibling)', () => {
    const doc = parseDocument(OPS_HTML);
    // move p#a before the table
    const out = serializeSource(doc, [
      { type: 'moveBlock', id: rid(doc, 'a'), beforeId: tagId(doc, 'table') },
    ]);
    expect(out.indexOf('id="b"')).toBeLessThan(out.indexOf('id="a"'));
    expect(out.indexOf('id="c"')).toBeLessThan(out.indexOf('id="a"'));
    expect(out.indexOf('id="a"')).toBeLessThan(out.indexOf('<table'));
  });

  it('beforeId === null appends to the end of the parent', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [
      { type: 'moveBlock', id: rid(doc, 'head1'), beforeId: null },
    ]);
    expect(bodyChildren(out).tags).toEqual(['p', 'p', 'div', 'table', 'h1']);
  });

  it('whitespace text nodes between blocks stay where they are', () => {
    const doc = parseDocument(OPS_HTML);
    const before = bodyChildren(serializePristine(doc));
    const out = serializeSource(doc, [
      { type: 'moveBlock', id: rid(doc, 'b'), beforeId: rid(doc, 'head1') },
    ]);
    const after = bodyChildren(out);
    // only the element moved — the whitespace between blocks is all still there
    expect(after.text).toBe(before.text);
    expect(after.tags).toEqual(['p', 'h1', 'p', 'div', 'table']);
  });
});

/** Fixture with a <template> in the body (parse5 keeps its children in el.content). */
const TEMPLATE_HTML = `<!DOCTYPE html>
<html><head><title>tpl fixture</title></head><body>
<template id="tpl"><p id="tp">tpl old</p></template>
<p id="after">after</p>
</body></html>
`;

describe('template elements', () => {
  it('editText on a <template> replaces its content (old content gone)', () => {
    const doc = parseDocument(TEMPLATE_HTML);
    const out = serializeSource(doc, [
      { type: 'editText', id: rid(doc, 'tpl'), html: '<p>fresh</p>' },
    ]);
    expect(out).toContain('<template id="tpl"><p>fresh</p></template>');
    expect(out).not.toContain('tpl old');
    expect(out).not.toContain('id="tp"');
    expect(out).toContain('<p id="after">after</p>');
  });

  it('deleteBlock of a template marks its content removed — later editText inside throws', () => {
    const doc = parseDocument(TEMPLATE_HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'deleteBlock', id: rid(doc, 'tpl') },
        { type: 'editText', id: rid(doc, 'tp'), html: 'x' },
      ]),
    ).toThrowError(/editText.*removed/);
  });

  it('editText replacing template content marks the old content removed', () => {
    const doc = parseDocument(TEMPLATE_HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'editText', id: rid(doc, 'tpl'), html: '<p>new</p>' },
        { type: 'editText', id: rid(doc, 'tp'), html: 'x' },
      ]),
    ).toThrowError(/editText.*removed/);
  });
});

describe('editText strips data-redra-id from fragments', () => {
  it('saved output has no data-redra-id, including template content inside the fragment', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [
      {
        type: 'editText',
        id: rid(doc, 'c'),
        html:
          '<b data-redra-id="r7">x</b>' +
          '<template data-redra-id="r8"><i data-redra-id="r9">y</i></template>',
      },
    ]);
    expect(out).not.toContain('data-redra-id');
    expect(out).toContain('<b>x</b>');
    expect(out).toContain('<template><i>y</i></template>');
  });
});

describe('error handling (RedraOpError)', () => {
  it('throws on an unknown id, naming the op type and id', () => {
    const doc = parseDocument(OPS_HTML);
    const op: Op = { type: 'editText', id: 'r9999', html: 'x' };
    expect(() => serializeSource(doc, [op])).toThrowError(RedraOpError);
    expect(() => serializeSource(doc, [op])).toThrowError(/editText.*r9999/);
  });

  it('throws when beforeId belongs to a different parent', () => {
    const doc = parseDocument(OPS_HTML);
    // title lives in head, p#a lives in body
    expect(() =>
      serializeSource(doc, [
        { type: 'moveBlock', id: rid(doc, 'a'), beforeId: tagId(doc, 'title') },
      ]),
    ).toThrowError(RedraOpError);
  });

  it('throws when moveBlock id === beforeId', () => {
    const doc = parseDocument(OPS_HTML);
    const a = rid(doc, 'a');
    expect(() =>
      serializeSource(doc, [{ type: 'moveBlock', id: a, beforeId: a }]),
    ).toThrowError(RedraOpError);
  });

  it('throws on editText targeting an element inside a previously deleted block', () => {
    const doc = parseDocument(OPS_HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'deleteBlock', id: rid(doc, 'c') },
        { type: 'editText', id: rid(doc, 'inner'), html: 'x' },
      ]),
    ).toThrowError(/editText.*removed/);
  });

  it('throws on deleteBlock applied twice to the same id', () => {
    const doc = parseDocument(OPS_HTML);
    const b = rid(doc, 'b');
    expect(() =>
      serializeSource(doc, [
        { type: 'deleteBlock', id: b },
        { type: 'deleteBlock', id: b },
      ]),
    ).toThrowError(RedraOpError);
  });
});

describe('op ordering', () => {
  it('[editText X, moveBlock X, deleteBlock Y] in order gives the expected output', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [
      { type: 'editText', id: rid(doc, 'a'), html: 'Edited alpha' },
      { type: 'moveBlock', id: rid(doc, 'a'), beforeId: null },
      { type: 'deleteBlock', id: rid(doc, 'b') },
    ]);
    expect(out).toContain('<p id="a" class="keep" data-x="1">Edited alpha</p>');
    expect(out).not.toContain('Beta');
    expect(bodyChildren(out).tags).toEqual(['h1', 'div', 'table', 'p']);
  });

  it('the same ops in a different order give a different (each correct) result', () => {
    const doc = parseDocument(OPS_HTML);
    const first: Op = { type: 'editText', id: rid(doc, 'a'), html: 'one' };
    const second: Op = { type: 'editText', id: rid(doc, 'a'), html: 'two' };
    const out12 = serializeSource(doc, [first, second]);
    const out21 = serializeSource(doc, [second, first]);
    expect(out12).not.toBe(out21);
    expect(out12).toContain('>two</p>');
    expect(out21).toContain('>one</p>');
  });
});

describe('serializeSource with ops', () => {
  it('leaves the pristine doc untouched (source, tree and id maps)', () => {
    const doc = parseDocument(OPS_HTML);
    const viewBefore = serializeForView(doc);
    serializeSource(doc, [
      { type: 'editText', id: rid(doc, 'a'), html: 'changed' },
      { type: 'deleteBlock', id: rid(doc, 'c') },
      { type: 'moveBlock', id: rid(doc, 'b'), beforeId: null },
    ]);
    expect(serializeSource(doc)).toBe(OPS_HTML);
    expect(serializePristine(doc)).toContain('Alpha');
    expect(serializePristine(doc)).toContain('inner text');
    expect(serializeForView(doc)).toBe(viewBefore);
    expect(getElementById(doc, rid(doc, 'inner'))).toBeDefined();
  });

  it('ops survive JSON round-trip and apply identically', () => {
    const doc = parseDocument(OPS_HTML);
    const ops: Op[] = [
      { type: 'editText', id: rid(doc, 'a'), html: 'json <b>safe</b>' },
      { type: 'moveBlock', id: rid(doc, 'b'), beforeId: rid(doc, 'head1') },
      { type: 'deleteBlock', id: rid(doc, 'c') },
    ];
    const revived = JSON.parse(JSON.stringify(ops)) as Op[];
    expect(serializeSource(doc, revived)).toBe(serializeSource(doc, ops));
  });

  it('the ops path is idempotent under reparse', () => {
    const doc = parseDocument(OPS_HTML);
    const out = serializeSource(doc, [
      { type: 'editText', id: rid(doc, 'a'), html: 'stable' },
      { type: 'deleteBlock', id: rid(doc, 'b') },
    ]);
    // reparsing the edited output and serializing its tree is a fixed point
    expect(serializePristine(parseDocument(out))).toBe(out);
    // and the verbatim path on the reparse returns the same bytes trivially
    expect(serializeSource(parseDocument(out))).toBe(out);
  });
});
