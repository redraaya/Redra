/**
 * Document-view preload: boots the live editing layer (Stage 3).
 *
 * Everything stays INSIDE the isolated world — nothing is exposed via
 * contextBridge. The spec sketched a window.__redraDoc bridge, but
 * exposeInMainWorld would hand the API to the PAGE's scripts, which is
 * exactly what contextIsolation protects against; the editing layer and its
 * IPC bridge simply live here as module state instead.
 */
import { ipcRenderer, webUtils } from 'electron';
import { createEditorController } from './editor/controller.js';
import type { EditorController } from './editor/controller.js';
import { createMdEditorController } from './editor/md-controller.js';
import type {
  CloneBlockResult,
  EditAvailability,
  FormatCommand,
  ImageValueResult,
  ModeState,
  OpPushResult,
  OpUndoResult,
  RedraDocBridge,
  TipInfo,
} from '../shared/ipc.js';

// The doc view WebContents is REUSED across documents, but this preload
// re-runs per navigation — so the docId baked into the page URL
// (redra://doc/<docId>/) identifies WHICH document this editing layer
// belongs to. Every ops call carries it; main rejects on mismatch, so an
// in-flight push from a previous document can never corrupt the journal of
// the next one (stamp ids like "r5" exist in every document).
const docId = window.location.pathname.split('/').filter(Boolean)[0] ?? '';

const bridge: RedraDocBridge = {
  pushOp: (op) => ipcRenderer.invoke('ops:push', docId, op) as Promise<OpPushResult>,
  cloneBlock: (id) => ipcRenderer.invoke('ops:cloneBlock', docId, id) as Promise<CloneBlockResult>,
  undo: () => ipcRenderer.invoke('ops:undo', docId) as Promise<OpUndoResult>,
  redo: () => ipcRenderer.invoke('ops:redo', docId) as Promise<OpUndoResult>,
  openExternal: (url) => {
    void ipcRenderer.invoke('link:openExternal', url);
  },
  pickImage: (id) => ipcRenderer.invoke('image:pick', docId, id) as Promise<ImageValueResult>,
  replaceImageFromPath: (id, path) =>
    ipcRenderer.invoke('image:fromPath', docId, id, path) as Promise<ImageValueResult>,
  pathForFile: (file) => webUtils.getPathForFile(file),
  notifyRejected: (message) => {
    ipcRenderer.send('ops:rejected-notice', message);
  },
  emitAvailability: (state: EditAvailability) => {
    ipcRenderer.send('edit:availability', state);
  },
  commitMdBody: (id, html, gen) =>
    ipcRenderer.invoke('md:commitBody', id, html, gen) as Promise<{ ok: boolean }>,
  mdDirty: (id, gen) => {
    ipcRenderer.send('md:dirty', id, gen);
  },
};

let controller: EditorController | null = null;
// Live editing is the DEFAULT ("click and write"); main may flip it before the
// DOM is ready, so the latest requested state is kept until boot.
let wantEditing = true;

window.addEventListener('DOMContentLoaded', () => {
  // The served document declares its format on <html data-redra-format>.
  // MD 2.0: markdown documents are TEXT — one whole-document contenteditable
  // (md-controller), no per-block sessions/handles/journal ops. HTML keeps
  // the per-block layer unchanged.
  const format = document.documentElement.getAttribute('data-redra-format') === 'md' ? 'md' : 'html';
  controller =
    format === 'md'
      ? createMdEditorController(window, bridge, docId)
      : createEditorController(window, bridge);
  controller.setEditing(wantEditing);
  // Liveness beacon: main's smoke mode fails the run when this never arrives
  // (e.g. the preload died on a bundling error — the editing layer IS the app).
  ipcRenderer.send('doc:editorReady');
});

ipcRenderer.on('mode:set', (_event, state: ModeState) => {
  wantEditing = state.editing;
  controller?.setEditing(state.editing);
});

ipcRenderer.on('edit:undo', () => controller?.handleUndo());
ipcRenderer.on('edit:redo', () => controller?.handleRedo());
ipcRenderer.on('edit:format', (_event, cmd: FormatCommand) => controller?.applyFormat(cmd));

// Titlebar tooltip: the shell detected the hover and converted the icon's
// position into this view's coordinates; we just draw it (over the document).
ipcRenderer.on('tip:show', (_event, info: TipInfo) => controller?.showTip(info.text, info.x, info.y));
ipcRenderer.on('tip:hide', () => controller?.hideTip());

ipcRenderer.on('edit:commit', (_event, nonce: unknown) => {
  // The ack carries whether the commit was ACCEPTED (md: body stored by main;
  // an over-cap rejection must NOT read as success — main fails the save
  // loudly instead of silently writing a stale body).
  const reply = (ok: boolean): void => ipcRenderer.send('edit:committed', nonce, ok);
  if (!controller) {
    reply(true); // nothing to commit
    return;
  }
  controller.commitActive().then(
    (ok) => reply(ok),
    () => reply(false),
  );
});
