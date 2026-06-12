import { beforeEach, describe, expect, it } from 'vitest';
import { FindBarModel } from '../../src/renderer/find-bar.js';

let model: FindBarModel;

beforeEach(() => {
  model = new FindBarModel();
});

describe('FindBarModel — open/close', () => {
  it('starts closed with no text and an empty counter', () => {
    expect(model.open).toBe(false);
    expect(model.text).toBe('');
    expect(model.counter).toBe('');
  });

  it('openBar opens; close stops the search and closes', () => {
    model.openBar();
    expect(model.open).toBe(true);
    expect(model.close()).toEqual([{ kind: 'stop' }]);
    expect(model.open).toBe(false);
  });

  it('close on an already-closed bar is a no-op (no duplicate stop)', () => {
    expect(model.close()).toEqual([]);
  });

  it('keeps the text across close/reopen (macOS convention), drops the counter', () => {
    model.openBar();
    model.setText('итог');
    model.applyResult({ activeMatchOrdinal: 2, matches: 9 });
    model.close();
    model.openBar();
    expect(model.text).toBe('итог');
    expect(model.counter).toBe('');
  });
});

describe('FindBarModel — typing', () => {
  beforeEach(() => model.openBar());

  it('non-empty text starts a new search', () => {
    expect(model.setText('от')).toEqual([{ kind: 'start', text: 'от' }]);
    expect(model.setText('отч')).toEqual([{ kind: 'start', text: 'отч' }]);
  });

  it('emptied text stops the search and clears the counter', () => {
    model.setText('x');
    model.applyResult({ activeMatchOrdinal: 1, matches: 4 });
    expect(model.setText('')).toEqual([{ kind: 'stop' }]);
    expect(model.counter).toBe('');
  });

  it('typing invalidates the previous counter until a new result arrives', () => {
    model.setText('a');
    model.applyResult({ activeMatchOrdinal: 1, matches: 4 });
    expect(model.counter).toBe('1/4');
    model.setText('ab');
    expect(model.counter).toBe('');
  });

  it('produces no commands while the bar is closed', () => {
    model.close();
    expect(model.setText('x')).toEqual([]);
    expect(model.step(true)).toEqual([]);
  });
});

describe('FindBarModel — stepping and counter', () => {
  beforeEach(() => model.openBar());

  it('Enter steps forward, Shift+Enter steps back, with the current text', () => {
    model.setText('q');
    expect(model.step(true)).toEqual([{ kind: 'next', text: 'q', forward: true }]);
    expect(model.step(false)).toEqual([{ kind: 'next', text: 'q', forward: false }]);
  });

  it('stepping with an empty query does nothing', () => {
    expect(model.step(true)).toEqual([]);
  });

  it('formats the counter as active/matches, including 0/0 for no matches', () => {
    model.setText('q');
    model.applyResult({ activeMatchOrdinal: 3, matches: 17 });
    expect(model.counter).toBe('3/17');
    model.applyResult({ activeMatchOrdinal: 0, matches: 0 });
    expect(model.counter).toBe('0/0');
  });

  it('ignores late results after close or after the query was cleared', () => {
    model.setText('q');
    model.close();
    model.applyResult({ activeMatchOrdinal: 1, matches: 2 });
    model.openBar();
    expect(model.counter).toBe('');
    model.setText('');
    model.applyResult({ activeMatchOrdinal: 1, matches: 2 });
    expect(model.counter).toBe('');
  });
});
