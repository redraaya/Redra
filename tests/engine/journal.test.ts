import { describe, expect, it } from 'vitest';
import { Journal, type Op } from '../../src/engine/index.js';

const opA: Op = { type: 'editText', id: 'r5', html: 'A' };
const opB: Op = { type: 'deleteBlock', id: 'r6' };
const opC: Op = { type: 'moveBlock', id: 'r7', beforeId: null };

describe('Journal: push / undo / redo', () => {
  it('starts empty: nothing to undo or redo, no active ops, not dirty', () => {
    const j = new Journal();
    expect(j.canUndo).toBe(false);
    expect(j.canRedo).toBe(false);
    expect(j.undo()).toBe(false);
    expect(j.redo()).toBe(false);
    expect(j.ops).toEqual([]);
    expect(j.dirty).toBe(false);
  });

  it('push appends at the cursor; ops returns everything up to the cursor', () => {
    const j = new Journal();
    j.push(opA);
    j.push(opB);
    expect(j.ops).toEqual([opA, opB]);
    expect(j.canUndo).toBe(true);
    expect(j.canRedo).toBe(false);
  });

  it('undo moves the cursor back, redo forward', () => {
    const j = new Journal();
    j.push(opA);
    j.push(opB);
    expect(j.undo()).toBe(true);
    expect(j.ops).toEqual([opA]);
    expect(j.canRedo).toBe(true);
    expect(j.redo()).toBe(true);
    expect(j.ops).toEqual([opA, opB]);
    expect(j.canRedo).toBe(false);
  });

  it('undo at the beginning and redo at the end return false', () => {
    const j = new Journal();
    j.push(opA);
    expect(j.undo()).toBe(true);
    expect(j.undo()).toBe(false);
    expect(j.redo()).toBe(true);
    expect(j.redo()).toBe(false);
  });

  it('push after undo truncates the redo tail', () => {
    const j = new Journal();
    j.push(opA);
    j.push(opB);
    j.undo();
    j.push(opC);
    expect(j.ops).toEqual([opA, opC]);
    expect(j.canRedo).toBe(false);
    expect(j.redo()).toBe(false);
  });
});

describe('Journal: dirty / markSaved', () => {
  it('dirty: false initially, true after push, false after markSaved', () => {
    const j = new Journal();
    j.push(opA);
    expect(j.dirty).toBe(true);
    j.markSaved();
    expect(j.dirty).toBe(false);
  });

  it('undo past the saved point makes it dirty again; redo back to it cleans it', () => {
    const j = new Journal();
    j.push(opA);
    j.push(opB);
    j.markSaved();
    expect(j.dirty).toBe(false);
    j.undo();
    expect(j.dirty).toBe(true);
    j.redo();
    expect(j.dirty).toBe(false);
  });

  it('push after markSaved makes it dirty; undo back to the saved point cleans it', () => {
    const j = new Journal();
    j.push(opA);
    j.markSaved();
    j.push(opB);
    expect(j.dirty).toBe(true);
    j.undo();
    expect(j.dirty).toBe(false);
  });

  it('markSaved at cursor 0 works', () => {
    const j = new Journal();
    j.markSaved();
    expect(j.dirty).toBe(false);
    j.push(opA);
    expect(j.dirty).toBe(true);
    j.undo();
    expect(j.dirty).toBe(false);
  });

  it('truncating the saved tail with a new push stays dirty even at the saved cursor', () => {
    const j = new Journal();
    j.push(opA);
    j.push(opB);
    j.markSaved();
    j.undo();
    j.push(opC); // [opA, opC] — same length as saved [opA, opB], different content
    expect(j.dirty).toBe(true);
  });
});
