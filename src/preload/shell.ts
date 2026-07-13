import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  DirtyState,
  DocOpenedInfo,
  EditAvailability,
  ExportResult,
  FindResult,
  ModeState,
  NoticeInfo,
  OpenResult,
  PerfEntry,
  RecentEntry,
  RedraShellApi,
  SaveResult,
  Settings,
  TipInfo,
  UpdateInfo,
} from '../shared/ipc.js';

const api: RedraShellApi = {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile') as Promise<OpenResult>,
  openPath: (filePath: string) => ipcRenderer.invoke('doc:open', filePath) as Promise<OpenResult>,
  newFile: () => ipcRenderer.invoke('doc:newFile') as Promise<OpenResult>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  save: () => ipcRenderer.invoke('doc:save') as Promise<SaveResult>,
  saveAs: () => ipcRenderer.invoke('doc:saveAs') as Promise<SaveResult>,
  exportPdf: () => ipcRenderer.invoke('doc:exportPdf') as Promise<ExportResult>,
  copyTelegram: () => {
    ipcRenderer.send('doc:copyTelegram');
  },
  togglePreview: () => ipcRenderer.send('mode:toggle'),
  undo: () => ipcRenderer.send('edit:undo'),
  redo: () => ipcRenderer.send('edit:redo'),
  onEditAvailability: (cb: (state: EditAvailability) => void) => {
    ipcRenderer.on('edit:availability', (_event, state: EditAvailability) => cb(state));
  },
  tipShow: (info: TipInfo) => ipcRenderer.send('tip:show', info),
  tipHide: () => ipcRenderer.send('tip:hide'),
  findStart: (text: string) => ipcRenderer.send('find:start', text),
  findNext: (text: string, forward: boolean) => ipcRenderer.send('find:next', text, forward),
  findStop: () => ipcRenderer.send('find:stop'),
  onFindOpen: (cb: () => void) => {
    ipcRenderer.on('find:open', () => cb());
  },
  onFindResult: (cb: (result: FindResult) => void) => {
    ipcRenderer.on('find:result', (_event, result: FindResult) => cb(result));
  },
  getRecents: () => ipcRenderer.invoke('recents:get') as Promise<RecentEntry[]>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
  getPerf: () => ipcRenderer.invoke('perf:get') as Promise<PerfEntry[]>,
  onDocOpened: (cb: (info: DocOpenedInfo) => void) => {
    ipcRenderer.on('doc:opened', (_event, info: DocOpenedInfo) => cb(info));
  },
  onDocRenamed: (cb: (info: DocOpenedInfo) => void) => {
    ipcRenderer.on('doc:renamed', (_event, info: DocOpenedInfo) => cb(info));
  },
  onDirtyChanged: (cb: (state: DirtyState) => void) => {
    ipcRenderer.on('doc:dirtyChanged', (_event, state: DirtyState) => cb(state));
  },
  onModeChanged: (cb: (state: ModeState) => void) => {
    ipcRenderer.on('mode:changed', (_event, state: ModeState) => cb(state));
  },
  onNotice: (cb: (notice: NoticeInfo) => void) => {
    ipcRenderer.on('notice:show', (_event, notice: NoticeInfo) => cb(notice));
  },
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => {
    ipcRenderer.on('update:available', (_event, info: UpdateInfo) => cb(info));
  },
  openUpdate: (url: string) => ipcRenderer.send('update:open', url),
  dismissUpdate: (version: string) => ipcRenderer.send('update:dismiss', version),
};

contextBridge.exposeInMainWorld('redra', api);
