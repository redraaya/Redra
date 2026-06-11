import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuHandlers {
  open(): void;
  save(): void;
  saveAs(): void;
  exportPdf(): void;
  /** Cmd+Z — routed to the doc view's editing layer (A4 logic decides). */
  undo(): void;
  /** Cmd+Shift+Z. */
  redo(): void;
  /** «Просмотр» checkbox, Cmd+E. Receives the NEW checked state. */
  togglePreview(checked: boolean): void;
  /** «Создавать резервную копию (.bak)» checkbox. Receives the NEW checked state. */
  toggleBackup(checked: boolean): void;
}

export interface MenuOptions {
  /** Initial state of the .bak checkbox (from settings). */
  backupChecked: boolean;
}

/** Menu items that only make sense with a document open (start disabled). */
const DOC_ITEM_IDS = ['file-save', 'file-save-as', 'file-export-pdf', 'view-preview'] as const;

export function buildAppMenu(handlers: MenuHandlers, options: MenuOptions): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({ role: 'appMenu' });
  }

  const fileSubmenu: MenuItemConstructorOptions[] = [
    { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: () => handlers.open() },
    { type: 'separator' },
    {
      id: 'file-save',
      label: 'Сохранить',
      accelerator: 'CmdOrCtrl+S',
      enabled: false,
      click: () => handlers.save(),
    },
    {
      id: 'file-save-as',
      label: 'Сохранить как…',
      accelerator: 'CmdOrCtrl+Shift+S',
      enabled: false,
      click: () => handlers.saveAs(),
    },
    {
      id: 'file-export-pdf',
      label: 'Экспорт в PDF…',
      accelerator: 'CmdOrCtrl+Shift+E',
      enabled: false,
      click: () => handlers.exportPdf(),
    },
    { type: 'separator' },
    {
      id: 'file-backup',
      label: 'Создавать резервную копию (.bak)',
      type: 'checkbox',
      checked: options.backupChecked,
      click: (item) => handlers.toggleBackup(item.checked),
    },
  ];
  if (!isMac) {
    fileSubmenu.push({ type: 'separator' }, { role: 'quit', label: 'Выход' });
  }
  template.push({ label: 'Файл', submenu: fileSubmenu });

  // Undo/Redo are OURS (journal + local DOM inverse stack in the doc preload);
  // clipboard/selection stay native roles so they keep working everywhere.
  template.push({
    label: 'Правка',
    submenu: [
      { label: 'Отменить', accelerator: 'CmdOrCtrl+Z', click: () => handlers.undo() },
      { label: 'Повторить', accelerator: 'CmdOrCtrl+Shift+Z', click: () => handlers.redo() },
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Скопировать' },
      { role: 'paste', label: 'Вставить' },
      { role: 'selectAll', label: 'Выделить всё' },
    ],
  });

  template.push({
    label: 'Вид',
    submenu: [
      {
        id: 'view-preview',
        label: 'Просмотр',
        type: 'checkbox',
        checked: false,
        enabled: false,
        accelerator: 'CmdOrCtrl+E',
        click: (item) => handlers.togglePreview(item.checked),
      },
    ],
  });

  template.push({ label: 'Окно', role: 'windowMenu' });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Enable/disable the document-dependent items (save / save as / pdf / preview). */
export function setDocMenuEnabled(on: boolean): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const id of DOC_ITEM_IDS) {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = on;
  }
}

/** Keep the .bak checkbox in sync when the setting changes outside the menu. */
export function setBackupMenuChecked(checked: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('file-backup');
  if (item) item.checked = checked;
}
