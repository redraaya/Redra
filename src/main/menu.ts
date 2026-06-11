import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuHandlers {
  open(): void;
  save(): void;
  saveAs(): void;
  /** Cmd+Z — routed to the doc view's editing layer (A4 logic decides). */
  undo(): void;
  /** Cmd+Shift+Z. */
  redo(): void;
  /** «Просмотр» checkbox, Cmd+E. Receives the NEW checked state. */
  togglePreview(checked: boolean): void;
}

export function buildAppMenu(handlers: MenuHandlers): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({ role: 'appMenu' });
  }

  const fileSubmenu: MenuItemConstructorOptions[] = [
    { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: () => handlers.open() },
    { type: 'separator' },
    { label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: () => handlers.save() },
    { label: 'Сохранить как…', accelerator: 'CmdOrCtrl+Shift+S', click: () => handlers.saveAs() },
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
        accelerator: 'CmdOrCtrl+E',
        click: (item) => handlers.togglePreview(item.checked),
      },
    ],
  });

  template.push({ label: 'Окно', role: 'windowMenu' });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
