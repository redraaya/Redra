import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { Translate } from '../shared/i18n.js';

export interface MenuHandlers {
  open(): void;
  save(): void;
  saveAs(): void;
  exportPdf(): void;
  /** Cmd+Z — routed to the doc view's editing layer (A4 logic decides). */
  undo(): void;
  /** Cmd+Shift+Z. */
  redo(): void;
  /** Preview checkbox, Cmd+E. Receives the NEW checked state. */
  togglePreview(checked: boolean): void;
  /** Backup checkbox. Receives the NEW checked state. */
  toggleBackup(checked: boolean): void;
  /** «Show backups» — opens the central backups folder. */
  showBackups(): void;
}

export interface MenuOptions {
  /** Initial state of the .bak checkbox (from settings). */
  backupChecked: boolean;
  /** Localized labels (RU when the system is Russian, EN otherwise). */
  t: Translate;
}

/** Menu items that only make sense with a document open (start disabled). */
const DOC_ITEM_IDS = ['file-save', 'file-save-as', 'file-export-pdf', 'view-preview'] as const;

export function buildAppMenu(handlers: MenuHandlers, options: MenuOptions): void {
  const isMac = process.platform === 'darwin';
  const { t } = options;
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    // Explicit app menu instead of role: 'appMenu' — the rest of the menu is
    // localized by our own table, so the standard items get matching labels
    // too. «About» is the stock panel: name, icon, version from Info.plist.
    template.push({
      label: 'Redra',
      submenu: [
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quitMac') },
      ],
    });
  }

  const fileSubmenu: MenuItemConstructorOptions[] = [
    { label: t('menu.open'), accelerator: 'CmdOrCtrl+O', click: () => handlers.open() },
    { type: 'separator' },
    {
      id: 'file-save',
      label: t('menu.save'),
      accelerator: 'CmdOrCtrl+S',
      enabled: false,
      click: () => handlers.save(),
    },
    {
      id: 'file-save-as',
      label: t('menu.saveAs'),
      accelerator: 'CmdOrCtrl+Shift+S',
      enabled: false,
      click: () => handlers.saveAs(),
    },
    {
      id: 'file-export-pdf',
      label: t('menu.exportPdf'),
      accelerator: 'CmdOrCtrl+Shift+E',
      enabled: false,
      click: () => handlers.exportPdf(),
    },
    { type: 'separator' },
    {
      id: 'file-backup',
      label: t('menu.backup'),
      type: 'checkbox',
      checked: options.backupChecked,
      click: (item) => handlers.toggleBackup(item.checked),
    },
    {
      id: 'file-show-backups',
      label: t('menu.showBackups'),
      // Always enabled: the folder is per-app, not per-document.
      click: () => handlers.showBackups(),
    },
  ];
  if (!isMac) {
    fileSubmenu.push({ type: 'separator' }, { role: 'quit', label: t('menu.quit') });
  }
  template.push({ label: t('menu.file'), submenu: fileSubmenu });

  // Undo/Redo are OURS (journal + local DOM inverse stack in the doc preload);
  // clipboard/selection stay native roles so they keep working everywhere.
  template.push({
    label: t('menu.edit'),
    submenu: [
      { label: t('menu.undo'), accelerator: 'CmdOrCtrl+Z', click: () => handlers.undo() },
      { label: t('menu.redo'), accelerator: 'CmdOrCtrl+Shift+Z', click: () => handlers.redo() },
      { type: 'separator' },
      { role: 'cut', label: t('menu.cut') },
      { role: 'copy', label: t('menu.copy') },
      { role: 'paste', label: t('menu.paste') },
      { role: 'selectAll', label: t('menu.selectAll') },
    ],
  });

  template.push({
    label: t('menu.view'),
    submenu: [
      {
        id: 'view-preview',
        label: t('menu.preview'),
        type: 'checkbox',
        checked: false,
        enabled: false,
        accelerator: 'CmdOrCtrl+E',
        click: (item) => handlers.togglePreview(item.checked),
      },
    ],
  });

  template.push({ label: t('menu.window'), role: 'windowMenu' });

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
