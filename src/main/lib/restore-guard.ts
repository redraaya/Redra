/**
 * Decision sequencing for "Version History" restore over unsaved edits.
 *
 * openFromBackup replaces BOTH the content and the journal, and its safety
 * snapshot covers only the DISK bytes — unsaved journal ops would vanish
 * silently, while the restore confirm promises "the current state will
 * be saved". So before the restore confirm, a dirty journal must go through
 * the standard three-button guard (the same askUnsavedChanges as window
 * close / open-over-dirty):
 *
 *  - "Save"       → save first; a failed/canceled save aborts the restore;
 *  - "Don't Save" → proceed, edits intentionally discarded;
 *  - "Cancel"     → abort the restore.
 *
 * Deliberately keyed on JOURNAL dirtiness, not DocumentManager.isDirty():
 * a restored-but-unsaved backup (restoredFromBackup with a clean journal)
 * is already preserved as a version in the backup store, so restoring over
 * it loses nothing — prompting "Save?" there would only confuse.
 *
 * Returns true when the restore may proceed.
 */
export async function resolveUnsavedBeforeRestore(deps: {
  journalDirty: boolean;
  askUnsavedChanges(): Promise<'save' | 'discard' | 'cancel'>;
  save(): Promise<{ ok: boolean }>;
}): Promise<boolean> {
  if (!deps.journalDirty) return true;
  const choice = await deps.askUnsavedChanges();
  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;
  return (await deps.save()).ok;
}
