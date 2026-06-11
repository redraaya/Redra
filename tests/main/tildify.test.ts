import { describe, expect, it } from 'vitest';
import { tildify } from '../../src/main/lib/tildify.js';

describe('tildify', () => {
  it('shortens paths under the home dir', () => {
    expect(tildify('/Users/sam/Documents/x', '/Users/sam')).toBe('~/Documents/x');
    expect(tildify('/Users/sam', '/Users/sam')).toBe('~');
  });

  it('tolerates a trailing slash on homeDir', () => {
    expect(tildify('/Users/sam/Desktop', '/Users/sam/')).toBe('~/Desktop');
  });

  it('leaves unrelated paths alone (incl. lookalike prefixes)', () => {
    expect(tildify('/tmp/x', '/Users/sam')).toBe('/tmp/x');
    expect(tildify('/Users/samna/doc', '/Users/sam')).toBe('/Users/samna/doc');
  });

  it('empty homeDir → unchanged', () => {
    expect(tildify('/a/b', '')).toBe('/a/b');
  });
});
