import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  DirtyState,
  DocOpenedInfo,
  ExportResult,
  ModeState,
  OpenResult,
  PerfEntry,
  RecentEntry,
  RedraShellApi,
  SaveResult,
  Settings,
  UpdateInfo,
} from '../shared/ipc.js';

const api: RedraShellApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile') as Promise<OpenResult>,
  openPath: (filePath: string) => ipcRenderer.invoke('doc:open', filePath) as Promise<OpenResult>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  save: () => ipcRenderer.invoke('doc:save') as Promise<SaveResult>,
  saveAs: () => ipcRenderer.invoke('doc:saveAs') as Promise<SaveResult>,
  exportPdf: () => ipcRenderer.invoke('doc:exportPdf') as Promise<ExportResult>,
  togglePreview: () => ipcRenderer.send('mode:toggle'),
  getRecents: () => ipcRenderer.invoke('recents:get') as Promise<RecentEntry[]>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
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
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => {
    ipcRenderer.on('update:available', (_event, info: UpdateInfo) => cb(info));
  },
  openUpdate: (url: string) => ipcRenderer.send('update:open', url),
  dismissUpdate: (version: string) => ipcRenderer.send('update:dismiss', version),
};

contextBridge.exposeInMainWorld('redra', api);
