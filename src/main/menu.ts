import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuHandlers {
  open(): void;
  save(): void;
  saveAs(): void;
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

  // Standard Edit menu — copy/paste must keep working inside the document view.
  template.push({ label: 'Правка', role: 'editMenu' });
  template.push({ label: 'Окно', role: 'windowMenu' });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
