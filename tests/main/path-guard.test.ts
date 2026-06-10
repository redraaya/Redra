import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveWithinRoot, resolveWithinRootReal } from '../../src/main/lib/path-guard.js';

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

describe('resolveWithinRootReal', () => {
  let base: string; // tmp sandbox: base/root is the doc dir, base/outside is foreign
  let root: string;
  let outside: string;

  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'redra-guard-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(root, 'real.txt'), 'inside');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    // symlinks: one escaping file, one escaping dir, one staying inside
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
    symlinkSync(outside, path.join(root, 'assets'));
    symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('rejects a symlinked file that points outside the root', async () => {
    expect(await resolveWithinRootReal(root, 'leak.txt')).toBeNull();
  });

  it('rejects a path through a symlinked directory that points outside the root', async () => {
    expect(await resolveWithinRootReal(root, 'assets/secret.txt')).toBeNull();
  });

  it('allows a symlink that stays within the root (returns the real path)', async () => {
    expect(await resolveWithinRootReal(root, 'alias.txt')).toBe(
      realpathSync(path.join(root, 'real.txt')),
    );
  });

  it('allows a plain existing file', async () => {
    expect(await resolveWithinRootReal(root, 'real.txt')).toBe(
      realpathSync(path.join(root, 'real.txt')),
    );
  });

  it('returns the lexical path for a nonexistent file (404 happens at readFile)', async () => {
    expect(await resolveWithinRootReal(root, 'img/missing.png')).toBe(
      path.resolve(root, 'img/missing.png'),
    );
  });

  it('still rejects lexical traversal before touching the filesystem', async () => {
    expect(await resolveWithinRootReal(root, '../outside/secret.txt')).toBeNull();
    expect(await resolveWithinRootReal(root, '%2e%2e/outside/secret.txt')).toBeNull();
  });
});
