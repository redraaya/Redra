import { describe, expect, it, vi } from 'vitest';
import { resolveUnsavedBeforeRestore } from '../../src/main/lib/restore-guard.js';

/** Deps factory: a journal state + scripted dialog choice + scripted save result. */
function makeDeps(
  journalDirty: boolean,
  choice: 'save' | 'discard' | 'cancel',
  saveOk = true,
) {
  const askUnsavedChanges = vi.fn(async () => choice);
  const save = vi.fn(async () => ({ ok: saveOk }));
  return { deps: { journalDirty, askUnsavedChanges, save }, askUnsavedChanges, save };
}

describe('resolveUnsavedBeforeRestore (version-restore over unsaved edits)', () => {
  it('clean journal: proceeds without asking anything', async () => {
    const { deps, askUnsavedChanges, save } = makeDeps(false, 'cancel');
    await expect(resolveUnsavedBeforeRestore(deps)).resolves.toBe(true);
    expect(askUnsavedChanges).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('dirty + «Отмена»: aborts the restore, nothing saved', async () => {
    const { deps, save } = makeDeps(true, 'cancel');
    await expect(resolveUnsavedBeforeRestore(deps)).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('dirty + «Не сохранять»: proceeds, edits intentionally discarded', async () => {
    const { deps, save } = makeDeps(true, 'discard');
    await expect(resolveUnsavedBeforeRestore(deps)).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('dirty + «Сохранить»: saves first, then proceeds', async () => {
    const { deps, save } = makeDeps(true, 'save', true);
    await expect(resolveUnsavedBeforeRestore(deps)).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('dirty + «Сохранить» but the save fails/cancels: aborts the restore', async () => {
    const { deps, save } = makeDeps(true, 'save', false);
    await expect(resolveUnsavedBeforeRestore(deps)).resolves.toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
