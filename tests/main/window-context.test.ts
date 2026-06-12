import { describe, expect, it } from 'vitest';
import { ContextRegistry, chooseOpenTarget, pathsEqual } from '../../src/main/window-context.js';
import type { ContextLike } from '../../src/main/window-context.js';

/** Minimal fake context — the registry only sees the structural interface. */
function fake(over: Partial<ContextLike> & { shellWcId: number }): ContextLike {
  return { docViewWcId: null, docId: null, docPath: null, ...over };
}

describe('ContextRegistry', () => {
  it('add / all / size / remove', () => {
    const reg = new ContextRegistry<ContextLike>();
    const a = fake({ shellWcId: 1 });
    const b = fake({ shellWcId: 2 });
    reg.add(a);
    reg.add(b);
    expect(reg.size).toBe(2);
    expect(reg.all()).toEqual([a, b]);

    expect(reg.remove(a)).toBe(true);
    expect(reg.remove(a)).toBe(false); // idempotent on double-remove
    expect(reg.size).toBe(1);
    expect(reg.all()).toEqual([b]);
  });

  it('byShellWcId resolves only registered shell senders', () => {
    const reg = new ContextRegistry<ContextLike>();
    const a = fake({ shellWcId: 7 });
    reg.add(a);
    expect(reg.byShellWcId(7)).toBe(a);
    expect(reg.byShellWcId(8)).toBeNull(); // unknown sender → reject
  });

  it('byDocWcId resolves doc-view senders and ignores contexts without a view', () => {
    const reg = new ContextRegistry<ContextLike>();
    const noView = fake({ shellWcId: 1 });
    const withView = fake({ shellWcId: 2, docViewWcId: 22 });
    reg.add(noView);
    reg.add(withView);
    expect(reg.byDocWcId(22)).toBe(withView);
    expect(reg.byDocWcId(1)).toBeNull(); // a SHELL id must not match doc lookups
    expect(reg.byDocWcId(99)).toBeNull();
  });

  it('byDocId finds the window serving a docId; stale docIds resolve to nothing', () => {
    const reg = new ContextRegistry<ContextLike>();
    const start = fake({ shellWcId: 1 }); // start screen: docId null
    const doc = fake({ shellWcId: 2, docId: 'doc-b' });
    reg.add(start);
    reg.add(doc);
    expect(reg.byDocId('doc-b')).toBe(doc);
    expect(reg.byDocId('doc-gone')).toBeNull(); // closed/replaced → 404 path
  });

  it('re-adding the same shellWcId replaces the entry instead of duplicating', () => {
    const reg = new ContextRegistry<ContextLike>();
    const first = fake({ shellWcId: 5, docId: 'old' });
    const second = fake({ shellWcId: 5, docId: 'new' });
    reg.add(first);
    reg.add(second);
    expect(reg.size).toBe(1);
    expect(reg.byDocId('new')).toBe(second);
  });

  describe('byDocPath ("same file already open in another window")', () => {
    const reg = new ContextRegistry<ContextLike>();
    const a = fake({ shellWcId: 1, docPath: '/docs/Report.html' });
    reg.add(a);
    reg.add(fake({ shellWcId: 2 })); // start screen — never matches

    it('exact match on any platform', () => {
      expect(reg.byDocPath('/docs/Report.html', 'linux')).toBe(a);
      expect(reg.byDocPath('/docs/Report.html', 'darwin')).toBe(a);
    });

    it('case-insensitive on darwin (APFS default), exact elsewhere', () => {
      expect(reg.byDocPath('/docs/report.HTML', 'darwin')).toBe(a);
      expect(reg.byDocPath('/docs/report.HTML', 'linux')).toBeNull();
    });

    it('different file → null', () => {
      expect(reg.byDocPath('/docs/Other.html', 'darwin')).toBeNull();
    });
  });
});

describe('pathsEqual', () => {
  it('identical strings match everywhere', () => {
    expect(pathsEqual('/a/b.html', '/a/b.html', 'linux')).toBe(true);
  });

  it('case differences match only on case-insensitive platforms', () => {
    expect(pathsEqual('/a/B.html', '/a/b.html', 'darwin')).toBe(true);
    expect(pathsEqual('/a/B.html', '/a/b.html', 'win32')).toBe(true);
    expect(pathsEqual('/a/B.html', '/a/b.html', 'linux')).toBe(false);
  });

  it('different paths never match', () => {
    expect(pathsEqual('/a/b.html', '/a/c.html', 'darwin')).toBe(false);
  });
});

describe('chooseOpenTarget (open-flow routing)', () => {
  type Entry = { name: string; free: boolean };
  const isFree = (e: Entry): boolean => e.free;

  it('reuses the focused window when it shows the start screen', () => {
    const focused: Entry = { name: 'focused', free: true };
    expect(chooseOpenTarget(focused, [focused], isFree)).toBe(focused);
  });

  it('focused window has a document → new window (null), even if another window is free', () => {
    const focused: Entry = { name: 'focused', free: false };
    const other: Entry = { name: 'other', free: true };
    expect(chooseOpenTarget(focused, [focused, other], isFree)).toBeNull();
  });

  it('focused window busy with a close dialog → new window (null)', () => {
    const focused: Entry = { name: 'focused', free: false }; // busy = not free
    expect(chooseOpenTarget(focused, [focused], isFree)).toBeNull();
  });

  it('no focused window (startup / dock open): any free window is reused', () => {
    const a: Entry = { name: 'a', free: false };
    const b: Entry = { name: 'b', free: true };
    expect(chooseOpenTarget(null, [a, b], isFree)).toBe(b);
  });

  it('no focused window and none free → new window (null)', () => {
    const a: Entry = { name: 'a', free: false };
    expect(chooseOpenTarget(null, [a], isFree)).toBeNull();
    expect(chooseOpenTarget<Entry>(null, [], isFree)).toBeNull();
  });
});
