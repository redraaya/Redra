/**
 * Document-view preload: boots the live editing layer (Stage 3).
 *
 * Everything stays INSIDE the isolated world — nothing is exposed via
 * contextBridge. The spec sketched a window.__redraDoc bridge, but
 * exposeInMainWorld would hand the API to the PAGE's scripts, which is
 * exactly what contextIsolation protects against; the editing layer and its
 * IPC bridge simply live here as module state instead.
 */
import { ipcRenderer } from 'electron';
import { createEditorController } from './editor/controller.js';
import type { EditorController } from './editor/controller.js';
import type { ModeState, OpPushResult, OpUndoResult, RedraDocBridge } from '../shared/ipc.js';

const bridge: RedraDocBridge = {
  pushOp: (op) => ipcRenderer.invoke('ops:push', op) as Promise<OpPushResult>,
  undo: () => ipcRenderer.invoke('ops:undo') as Promise<OpUndoResult>,
  redo: () => ipcRenderer.invoke('ops:redo') as Promise<OpUndoResult>,
  openExternal: (url) => {
    void ipcRenderer.invoke('link:openExternal', url);
  },
};

let controller: EditorController | null = null;
// Live editing is the DEFAULT («тыц и пиши»); main may flip it before the
// DOM is ready, so the latest requested state is kept until boot.
let wantEditing = true;

window.addEventListener('DOMContentLoaded', () => {
  controller = createEditorController(window, bridge);
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

ipcRenderer.on('edit:commit', (_event, nonce: unknown) => {
  const reply = (): void => ipcRenderer.send('edit:committed', nonce);
  if (!controller) {
    reply();
    return;
  }
  void controller.commitActive().finally(reply);
});
