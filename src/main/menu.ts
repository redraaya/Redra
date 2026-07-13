import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { Translate } from '../shared/i18n.js';

export interface MenuHandlers {
  /** ⌘N — a new untitled Markdown document (created in a free/new window). */
  newFile(): void;
  /** ⌘⇧N — a new empty window showing the start screen. */
  newWindow(): void;
  open(): void;
  save(): void;
  saveAs(): void;
  exportPdf(): void;
  /** Cmd+Z — routed to the doc view's editing layer (A4 logic decides). */
  undo(): void;
  /** Cmd+Shift+Z. */
  redo(): void;
  /** ⌘F — tells the focused window's SHELL to open the find bar. */
  find(): void;
  /** Preview checkbox, Cmd+E. Receives the NEW checked state. */
  togglePreview(checked: boolean): void;
  /** Backup checkbox. Receives the NEW checked state. */
  toggleBackup(checked: boolean): void;
  /** «Show backups» — opens the central backups folder. */
  showBackups(): void;
  /** "Version History" item clicked — confirm + restore flow lives in main. */
  restoreVersion(version: VersionMenuItem): void;
  /** ⌥⌘C — copy the current Markdown document to the clipboard in Telegram's
   *  MarkdownV2 + HTML flavors (Markdown documents only). */
  copyTelegram(): void;
}

/** One entry of the "Version History" submenu (built by main from BackupStore.list). */
export interface VersionMenuItem {
  /** `<date time> · <size KB>`, locale-formatted. */
  label: string;
  /** Locale-formatted date for the confirm dialog ("Restore the version from …?"). */
  dateLabel: string;
  /** Absolute path of the backup file. */
  backupPath: string;
}

export interface MenuOptions {
  /** Initial state of the .bak checkbox (from settings). */
  backupChecked: boolean;
  /** Localized labels (RU when the system is Russian, EN otherwise). */
  t: Translate;
  /** A document is open: doc-only items start enabled. */
  docOpen?: boolean;
  /** The open document is Markdown — enables "Copy for Telegram". */
  isMarkdown?: boolean;
  /** Current Preview state for the View checkbox. */
  previewChecked?: boolean;
  /** "Version History" entries for the current document, newest first (≤10). */
  versions?: VersionMenuItem[];
}

export function buildAppMenu(handlers: MenuHandlers, options: MenuOptions): void {
  const isMac = process.platform === 'darwin';
  const { t } = options;
  const docOpen = options.docOpen ?? false;
  const versions = options.versions ?? [];
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
    // ⌘N mints a new Markdown document (v0.5); a blank window moves to ⌘⇧N.
    { label: t('menu.newFile'), accelerator: 'CmdOrCtrl+N', click: () => handlers.newFile() },
    {
      label: t('menu.newWindow'),
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => handlers.newWindow(),
    },
    { label: t('menu.open'), accelerator: 'CmdOrCtrl+O', click: () => handlers.open() },
    { type: 'separator' },
    // Standard macOS Close (⌘W). The unsaved-changes close guard intercepts
    // the window 'close' event, so this is always safe.
    { role: 'close', label: t('menu.close'), accelerator: 'CmdOrCtrl+W' },
    { type: 'separator' },
    {
      id: 'file-save',
      label: t('menu.save'),
      accelerator: 'CmdOrCtrl+S',
      enabled: docOpen,
      click: () => handlers.save(),
    },
    {
      id: 'file-save-as',
      label: t('menu.saveAs'),
      accelerator: 'CmdOrCtrl+Shift+S',
      enabled: docOpen,
      click: () => handlers.saveAs(),
    },
    {
      id: 'file-export-pdf',
      label: t('menu.exportPdf'),
      accelerator: 'CmdOrCtrl+Shift+E',
      enabled: docOpen,
      click: () => handlers.exportPdf(),
    },
    { type: 'separator' },
    {
      id: 'file-version-history',
      label: t('menu.versionHistory'),
      enabled: docOpen,
      submenu: versions.length
        ? versions.map(
            (v): MenuItemConstructorOptions => ({
              label: v.label,
              click: () => handlers.restoreVersion(v),
            }),
          )
        : [{ label: t('menu.noVersions'), enabled: false }],
    },
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
      { type: 'separator' },
      {
        id: 'edit-copy-telegram',
        label: t('menu.copyTelegram'),
        accelerator: 'CmdOrCtrl+Alt+C',
        enabled: docOpen && (options.isMarkdown ?? false),
        click: () => handlers.copyTelegram(),
      },
      {
        id: 'edit-find',
        label: t('menu.find'),
        accelerator: 'CmdOrCtrl+F',
        enabled: docOpen,
        click: () => handlers.find(),
      },
    ],
  });

  template.push({
    label: t('menu.view'),
    submenu: [
      {
        id: 'view-preview',
        label: t('menu.preview'),
        type: 'checkbox',
        checked: options.previewChecked ?? false,
        enabled: docOpen,
        accelerator: 'CmdOrCtrl+E',
        click: (item) => handlers.togglePreview(item.checked),
      },
    ],
  });

  template.push({ label: t('menu.window'), role: 'windowMenu' });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Keep the .bak checkbox in sync when the setting changes outside the menu. */
export function setBackupMenuChecked(checked: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('file-backup');
  if (item) item.checked = checked;
}
