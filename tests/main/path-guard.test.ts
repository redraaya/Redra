import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWithinRoot } from '../../src/main/lib/path-guard.js';

const ROOT = path.resolve('/tmp/redra-docs/report');

describe('resolveWithinRoot', () => {
  it('resolves a simple relative path inside the root', () => {
    expect(resolveWithinRoot(ROOT, 'img/chart.png')).toBe(path.join(ROOT, 'img', 'chart.png'));
  });

  it('resolves nested ok-paths with dots that stay inside', () => {
    expect(resolveWithinRoot(ROOT, 'a/b/../b/file.css')).toBe(path.join(ROOT, 'a', 'b', 'file.css'));
  });

  it('allows the root itself (empty path)', () => {
    expect(resolveWithinRoot(ROOT, '')).toBe(ROOT);
  });

  it('rejects ../ escape', () => {
    expect(resolveWithinRoot(ROOT, '../secret.txt')).toBeNull();
    expect(resolveWithinRoot(ROOT, 'img/../../secret.txt')).toBeNull();
    expect(resolveWithinRoot(ROOT, '..')).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(resolveWithinRoot(ROOT, '/etc/passwd')).toBeNull();
    expect(resolveWithinRoot(ROOT, '\\\\server\\share')).toBeNull();
    expect(resolveWithinRoot(ROOT, 'C:/windows/system32')).toBeNull();
    expect(resolveWithinRoot(ROOT, 'c:\\evil')).toBeNull();
  });

  it('rejects percent-encoded traversal (%2e%2e)', () => {
    expect(resolveWithinRoot(ROOT, '%2e%2e/secret.txt')).toBeNull();
    expect(resolveWithinRoot(ROOT, '%2e%2e%2f%2e%2e%2fsecret.txt')).toBeNull();
    expect(resolveWithinRoot(ROOT, 'img/%2e%2e/%2e%2e/secret.txt')).toBeNull();
  });

  it('rejects malformed percent-encoding and NUL bytes', () => {
    expect(resolveWithinRoot(ROOT, '%zz')).toBeNull();
    expect(resolveWithinRoot(ROOT, 'file%00.png')).toBeNull();
  });

  it('does not treat a sibling dir with the same prefix as inside', () => {
    // /tmp/redra-docs/report-extra is NOT inside /tmp/redra-docs/report
    expect(resolveWithinRoot(ROOT, '../report-extra/file.png')).toBeNull();
  });
});
