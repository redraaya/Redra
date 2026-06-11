import { describe, expect, it } from 'vitest';
import { tildify } from '../../src/main/lib/tildify.js';

describe('tildify', () => {
  it('shortens paths under the home dir', () => {
    expect(tildify('/Users/ya/Documents/x', '/Users/ya')).toBe('~/Documents/x');
    expect(tildify('/Users/ya', '/Users/ya')).toBe('~');
  });

  it('tolerates a trailing slash on homeDir', () => {
    expect(tildify('/Users/ya/Desktop', '/Users/ya/')).toBe('~/Desktop');
  });

  it('leaves unrelated paths alone (incl. lookalike prefixes)', () => {
    expect(tildify('/tmp/x', '/Users/ya')).toBe('/tmp/x');
    expect(tildify('/Users/yana/doc', '/Users/ya')).toBe('/Users/yana/doc');
  });

  it('empty homeDir → unchanged', () => {
    expect(tildify('/a/b', '')).toBe('/a/b');
  });
});
