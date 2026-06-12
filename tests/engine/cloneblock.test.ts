import { describe, expect, it } from 'vitest';
import {
  cloneRootOf,
  getElementById,
  parseDocument,
  RedraOpError,
  renderCloneFragment,
  serializeSource,
  type Element,
  type Op,
  type RedraDoc,
} from '../../src/engine/index.js';
import { serializePristine } from '../../src/engine/serialize.js';

/**
 * cloneBlock fixture. Body blocks: h1, div#card (with span + img inside),
 * p#tail, template#tpl (with p#tp inside).
 */
const CLONE_HTML = `<!DOCTYPE html>
<html><head><title>clone fixture</title></head><body>
<h1 id="head1">Title</h1>
<div id="card" class="card"><span id="lbl" class="lbl">Label</span><img id="pic" src="a.png"></div>
<p id="tail">tail</p>
<template id="tpl"><p id="tp" class="t">tpl text</p></template>
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

function clone(doc: RedraDoc, domId: string, cloneId = 'c1'): Op {
  return { type: 'cloneBlock', id: rid(doc, domId), cloneId };
}

describe('cloneBlock: basic cloning', () => {
  it('inserts the clone immediately after the original among its siblings', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [clone(doc, 'card')]);
    const first = out.indexOf('id="card"');
    const second = out.indexOf('id="card"', first + 1);
    expect(second).toBeGreaterThan(first);
    // the clone sits BEFORE p#tail (right after the original)
    expect(second).toBeLessThan(out.indexOf('id="tail"'));
  });

  it('deep-clones attributes and children', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [clone(doc, 'card')]);
    const cards = out.match(/<div id="card" class="card"><span id="lbl" class="lbl">Label<\/span><img id="pic" src="a.png"><\/div>/g);
    expect(cards).toHaveLength(2);
  });

  it('clones template content (parse5 keeps it in el.content)', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [clone(doc, 'tpl')]);
    const tpls = out.match(/<template id="tpl"><p id="tp" class="t">tpl text<\/p><\/template>/g);
    expect(tpls).toHaveLength(2);
  });

  it('never emits data-redra-id (clone ids live in the map, not as attributes)', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [clone(doc, 'card'), clone(doc, 'tpl', 'c2')]);
    expect(out).not.toContain('data-redra-id');
  });

  it('clones the CURRENT state of the target: an earlier editText is reflected in the clone', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [
      { type: 'editText', id: rid(doc, 'tail'), html: 'rewritten' },
      clone(doc, 'tail'),
    ]);
    expect(out.match(/>rewritten</g)).toHaveLength(2);
    expect(out).not.toContain('>tail<');
  });
});

describe('cloneBlock: derived ids resolve for subsequent ops', () => {
  it('editText on the clone root (cloneId) edits the clone, not the original', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [
      clone(doc, 'card'),
      { type: 'editText', id: 'c1', html: 'rewritten' },
    ]);
    expect(out).toContain('<div id="card" class="card">rewritten</div>');
    expect(out).toContain('<span id="lbl" class="lbl">Label</span>'); // original intact
  });

  it('editText on a clone DESCENDANT (cloneId-n, walkElements order) edits the right element', () => {
    const doc = parseDocument(CLONE_HTML);
    // div#card descendants in walk order: span#lbl = c1-1, img#pic = c1-2
    const out = serializeSource(doc, [
      clone(doc, 'card'),
      { type: 'editText', id: 'c1-1', html: 'CloneLabel' },
    ]);
    expect(out).toContain('<span id="lbl" class="lbl">CloneLabel</span>');
    expect(out).toContain('<span id="lbl" class="lbl">Label</span>');
  });

  it('template-content descendants get ids too (content walked before children)', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [
      clone(doc, 'tpl'),
      { type: 'editText', id: 'c1-1', html: 'fresh' },
    ]);
    expect(out).toContain('<p id="tp" class="t">fresh</p>');
    expect(out).toContain('<p id="tp" class="t">tpl text</p>');
  });

  it('deleteBlock on the clone removes only the clone', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [clone(doc, 'card'), { type: 'deleteBlock', id: 'c1' }]);
    expect(out.match(/id="card"/g)).toHaveLength(1);
  });

  it('moveBlock on the clone reorders it among its siblings', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [
      clone(doc, 'card'),
      { type: 'moveBlock', id: 'c1', beforeId: rid(doc, 'head1') },
    ]);
    // clone moved before h1, original stays in place
    const h1 = out.indexOf('<h1');
    const first = out.indexOf('id="card"');
    const second = out.indexOf('id="card"', first + 1);
    expect(first).toBeLessThan(h1);
    expect(second).toBeGreaterThan(h1);
  });

  it('setAttr src on a cloned img targets the clone copy', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [
      clone(doc, 'card'),
      { type: 'setAttr', id: 'c1-2', name: 'src', value: 'data:image/png;base64,BB' },
    ]);
    expect(out).toContain('src="a.png"');
    expect(out).toContain('src="data:image/png;base64,BB"');
  });

  it('editText on a clone element gates STAMPED fragments against the clone map', () => {
    const doc = parseDocument(CLONE_HTML);
    // Live DOM carries stamps c1-1 on the cloned span; runtime mutated its
    // class — the gate must restore the CLONE's pristine-derived attributes.
    const out = serializeSource(doc, [
      clone(doc, 'card'),
      {
        type: 'editText',
        id: 'c1',
        html: '<span data-redra-id="c1-1" class="lbl open">Mutated</span>',
      },
    ]);
    expect(out).toContain('<span id="lbl" class="lbl">Mutated</span>');
    expect(out).not.toContain('lbl open');
    expect(out).not.toContain('data-redra-id');
  });

  it('cloning a clone works (target = cloneId of an earlier cloneBlock)', () => {
    const doc = parseDocument(CLONE_HTML);
    const out = serializeSource(doc, [
      clone(doc, 'tail'),
      { type: 'cloneBlock', id: 'c1', cloneId: 'c2' },
    ]);
    expect(out.match(/>tail</g)).toHaveLength(3);
  });
});

describe('cloneBlock: determinism and undo', () => {
  it('the same ops always serialize to the same output', () => {
    const doc = parseDocument(CLONE_HTML);
    const ops: Op[] = [
      clone(doc, 'card'),
      { type: 'editText', id: 'c1-1', html: 'x' },
      clone(doc, 'tpl', 'c2'),
    ];
    expect(serializeSource(doc, ops)).toBe(serializeSource(doc, ops));
    const revived = JSON.parse(JSON.stringify(ops)) as Op[];
    expect(serializeSource(doc, revived)).toBe(serializeSource(doc, ops));
  });

  it('dropping the cloneBlock op from the journal removes the clone (undo)', () => {
    const doc = parseDocument(CLONE_HTML);
    const withClone = serializeSource(doc, [clone(doc, 'card')]);
    expect(withClone.match(/id="card"/g)).toHaveLength(2);
    expect(serializeSource(doc, [])).toBe(CLONE_HTML);
  });

  it('leaves the pristine doc untouched (source, tree, id maps)', () => {
    const doc = parseDocument(CLONE_HTML);
    serializeSource(doc, [clone(doc, 'card'), { type: 'editText', id: 'c1', html: 'x' }]);
    expect(serializeSource(doc)).toBe(CLONE_HTML);
    expect(serializePristine(doc)).toContain('Label');
    expect(getElementById(doc, 'c1')).toBeUndefined(); // clone ids never leak into the pristine maps
  });
});

describe('cloneBlock: validation errors', () => {
  it.each(['x1', 'c1x', 'c', 'c1-2', 'r5', ''])('rejects cloneId %j (format must be c<number>)', (bad) => {
    const doc = parseDocument(CLONE_HTML);
    expect(() =>
      serializeSource(doc, [{ type: 'cloneBlock', id: rid(doc, 'tail'), cloneId: bad }]),
    ).toThrowError(RedraOpError);
  });

  it('rejects a duplicate cloneId', () => {
    const doc = parseDocument(CLONE_HTML);
    expect(() =>
      serializeSource(doc, [clone(doc, 'tail'), clone(doc, 'head1')]),
    ).toThrowError(/cloneBlock.*already/);
  });

  it('rejects an unknown target id', () => {
    const doc = parseDocument(CLONE_HTML);
    expect(() =>
      serializeSource(doc, [{ type: 'cloneBlock', id: 'r9999', cloneId: 'c1' }]),
    ).toThrowError(RedraOpError);
  });

  it('rejects cloning an element inside a deleted subtree', () => {
    const doc = parseDocument(CLONE_HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'deleteBlock', id: rid(doc, 'card') },
        { type: 'cloneBlock', id: rid(doc, 'lbl'), cloneId: 'c1' },
      ]),
    ).toThrowError(/cloneBlock.*removed/);
  });

  it('rejects cloning an element whose subtree was consumed by editText', () => {
    const doc = parseDocument(CLONE_HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'editText', id: rid(doc, 'card'), html: 'new' },
        { type: 'cloneBlock', id: rid(doc, 'lbl'), cloneId: 'c1' },
      ]),
    ).toThrowError(/cloneBlock.*removed/);
  });

  it('rejects cloning the deleted element itself', () => {
    const doc = parseDocument(CLONE_HTML);
    expect(() =>
      serializeSource(doc, [
        { type: 'deleteBlock', id: rid(doc, 'card') },
        { type: 'cloneBlock', id: rid(doc, 'card'), cloneId: 'c1' },
      ]),
    ).toThrowError(/cloneBlock.*removed/);
  });
});

describe('renderCloneFragment', () => {
  it('returns the clone outer HTML with data-redra-id stamps on root and descendants', () => {
    const doc = parseDocument(CLONE_HTML);
    const html = renderCloneFragment(doc, [], rid(doc, 'card'), 'c1');
    expect(html).toBe(
      '<div id="card" class="card" data-redra-id="c1">' +
        '<span id="lbl" class="lbl" data-redra-id="c1-1">Label</span>' +
        '<img id="pic" src="a.png" data-redra-id="c1-2"></div>',
    );
  });

  it('stamps template content descendants', () => {
    const doc = parseDocument(CLONE_HTML);
    const html = renderCloneFragment(doc, [], rid(doc, 'tpl'), 'c1');
    expect(html).toContain('<template id="tpl" data-redra-id="c1">');
    expect(html).toContain('<p id="tp" class="t" data-redra-id="c1-1">tpl text</p>');
  });

  it('reflects earlier active ops (clone of an edited block shows the edit)', () => {
    const doc = parseDocument(CLONE_HTML);
    const html = renderCloneFragment(
      doc,
      [{ type: 'editText', id: rid(doc, 'tail'), html: 'rewritten' }],
      rid(doc, 'tail'),
      'c1',
    );
    expect(html).toBe('<p id="tail" data-redra-id="c1">rewritten</p>');
  });

  it('leaves the pristine doc untouched and throws RedraOpError for bad input', () => {
    const doc = parseDocument(CLONE_HTML);
    renderCloneFragment(doc, [], rid(doc, 'card'), 'c1');
    expect(serializeSource(doc)).toBe(CLONE_HTML);
    expect(() => renderCloneFragment(doc, [], 'r9999', 'c1')).toThrowError(RedraOpError);
    expect(() => renderCloneFragment(doc, [], rid(doc, 'card'), 'bogus')).toThrowError(
      RedraOpError,
    );
  });
});

describe('cloneRootOf', () => {
  it('extracts the root of minted clone ids', () => {
    expect(cloneRootOf('c1')).toBe('c1');
    expect(cloneRootOf('c12-34')).toBe('c12');
    expect(cloneRootOf('r5')).toBeNull();
    expect(cloneRootOf('c1-2-3')).toBeNull();
    expect(cloneRootOf('c')).toBeNull();
    expect(cloneRootOf('')).toBeNull();
  });
});
