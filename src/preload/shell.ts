import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  DirtyState,
  DocOpenedInfo,
  ModeState,
  OpenResult,
  PerfEntry,
  RedraShellApi,
  SaveResult,
} from '../shared/ipc.js';

const api: RedraShellApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile') as Promise<OpenResult>,
  openPath: (filePath: string) => ipcRenderer.invoke('doc:open', filePath) as Promise<OpenResult>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  save: () => ipcRenderer.invoke('doc:save') as Promise<SaveResult>,
  saveAs: () => ipcRenderer.invoke('doc:saveAs') as Promise<SaveResult>,
  getRecents: () => ipcRenderer.invoke('recents:get') as Promise<string[]>,
  getPerf: () => ipcRenderer.invoke('perf:get') as Promise<PerfEntry[]>,
  onDocOpened: (cb: (info: DocOpenedInfo) => void) => {
    ipcRenderer.on('doc:opened', (_event, info: DocOpenedInfo) => cb(info));
  },
  onDirtyChanged: (cb: (state: DirtyState) => void) => {
    ipcRenderer.on('doc:dirtyChanged', (_event, state: DirtyState) => cb(state));
  },
  onModeChanged: (cb: (state: ModeState) => void) => {
    ipcRenderer.on('mode:changed', (_event, state: ModeState) => cb(state));
  },
};

contextBridge.exposeInMainWorld('redra', api);
