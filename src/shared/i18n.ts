/**
 * Tiny two-language string table: Russian when the system locale is Russian,
 * English otherwise. Auto only — no setting, no override.
 *
 * Consumers pick the language once at startup:
 *   main process     → app.getLocale()        (after 'ready')
 *   shell renderer   → navigator.language
 *   doc preload      → navigator.language     (isolated world, same value)
 *
 * Keys are typed, so a missing key is a compile error; at runtime an unknown
 * key falls back to the key itself rather than throwing.
 */

export type Lang = 'ru' | 'en';

/** ru / ru-RU / ru_RU → 'ru'; everything else (incl. uk, be) → 'en'. */
export function pickLang(locale: string): Lang {
  return /^ru(?:[-_]|$)/i.test(locale) ? 'ru' : 'en';
}

const STRINGS = {
  // --- application menu -----------------------------------------------------
  'menu.about': { ru: 'О программе Redra', en: 'About Redra' },
  'menu.services': { ru: 'Службы', en: 'Services' },
  'menu.hide': { ru: 'Скрыть Redra', en: 'Hide Redra' },
  'menu.hideOthers': { ru: 'Скрыть остальные', en: 'Hide Others' },
  'menu.unhide': { ru: 'Показать все', en: 'Show All' },
  'menu.quitMac': { ru: 'Завершить Redra', en: 'Quit Redra' },
  'menu.quit': { ru: 'Выход', en: 'Exit' },
  'menu.file': { ru: 'Файл', en: 'File' },
  'menu.newFile': { ru: 'Новый файл', en: 'New File' },
  'menu.newWindow': { ru: 'Новое окно', en: 'New Window' },
  'menu.open': { ru: 'Открыть…', en: 'Open…' },
  'menu.close': { ru: 'Закрыть окно', en: 'Close Window' },
  'menu.save': { ru: 'Сохранить', en: 'Save' },
  'menu.saveAs': { ru: 'Сохранить как…', en: 'Save As…' },
  'menu.exportPdf': { ru: 'Экспорт в PDF…', en: 'Export to PDF…' },
  'menu.backup': { ru: 'Создавать резервную копию', en: 'Keep a backup of the original' },
  'menu.showBackups': { ru: 'Показать резервные копии', en: 'Show backups' },
  'menu.versionHistory': { ru: 'История версий', en: 'Version History' },
  'menu.noVersions': { ru: 'Нет сохранённых версий', en: 'No saved versions' },
  'menu.edit': { ru: 'Правка', en: 'Edit' },
  'menu.find': { ru: 'Найти…', en: 'Find…' },
  'menu.undo': { ru: 'Отменить', en: 'Undo' },
  'menu.redo': { ru: 'Повторить', en: 'Redo' },
  'menu.cut': { ru: 'Вырезать', en: 'Cut' },
  'menu.copy': { ru: 'Скопировать', en: 'Copy' },
  'menu.copyTelegram': { ru: 'Скопировать для Telegram', en: 'Copy for Telegram' },
  'notice.copiedTelegram': { ru: 'Скопировано для Telegram', en: 'Copied for Telegram' },
  'menu.paste': { ru: 'Вставить', en: 'Paste' },
  'menu.selectAll': { ru: 'Выделить всё', en: 'Select All' },
  'menu.format': { ru: 'Формат', en: 'Format' },
  'menu.view': { ru: 'Вид', en: 'View' },
  'menu.preview': { ru: 'Просмотр', en: 'Preview' },
  'menu.window': { ru: 'Окно', en: 'Window' },

  // --- main-process dialogs ---------------------------------------------------
  'dialog.unsaved.message': {
    ru: 'Сохранить изменения в «{name}»?',
    en: 'Save changes to “{name}”?',
  },
  'dialog.unsaved.save': { ru: 'Сохранить', en: 'Save' },
  'dialog.unsaved.discard': { ru: 'Не сохранять', en: 'Don’t Save' },
  'dialog.cancel': { ru: 'Отмена', en: 'Cancel' },
  'dialog.conflict.message': {
    ru: 'Файл на диске изменён другой программой',
    en: 'The file on disk was changed by another app',
  },
  'dialog.conflict.detail': {
    ru: 'Перезаписать его версией из Redra? Внешние изменения будут потеряны.',
    en: 'Overwrite it with the version from Redra? The external changes will be lost.',
  },
  'dialog.conflict.overwrite': { ru: 'Перезаписать', en: 'Overwrite' },
  'dialog.restore.message': {
    ru: 'Восстановить версию от {date}?',
    en: 'Restore the version from {date}?',
  },
  'dialog.restore.detail': {
    ru: 'Текущее состояние файла будет сохранено в резервные копии.',
    en: 'The current state of the file will be backed up first.',
  },
  'dialog.restore.confirm': { ru: 'Восстановить', en: 'Restore' },
  'error.restoreTitle': { ru: 'Не удалось восстановить версию', en: 'Can’t restore version' },
  'unit.kb': { ru: 'КБ', en: 'KB' },
  'error.noDocument': { ru: 'Документ не открыт', en: 'No document is open' },
  'error.keepsChanging': {
    ru: 'Файл на диске продолжает меняться — сохранение прервано',
    en: 'The file on disk keeps changing — save aborted',
  },
  'error.unknown': { ru: 'неизвестная ошибка', en: 'unknown error' },
  'error.saveTitle': { ru: 'Не удалось сохранить', en: 'Can’t save' },
  'error.pdfTitle': { ru: 'Не удалось экспортировать PDF', en: 'Can’t export PDF' },
  'error.openTitle': { ru: 'Не удалось открыть файл', en: 'Can’t open file' },
  'error.imageTitle': { ru: 'Не удалось заменить картинку', en: 'Can’t replace image' },
  'image.tooBig': {
    ru: 'Картинка слишком большая (макс. 10 МБ)',
    en: 'Image is too large (max 10 MB)',
  },
  'image.badType': {
    ru: 'Файл не похож на картинку (PNG, JPEG, WebP, GIF, SVG, AVIF)',
    en: 'The file is not an image (PNG, JPEG, WebP, GIF, SVG, AVIF)',
  },
  'dialog.imagesFilter': { ru: 'Картинки', en: 'Images' },
  'dialog.documentsFilter': { ru: 'HTML и Markdown', en: 'HTML & Markdown' },
  // Rejected-op toast (quiet pill in the shell strip, auto-hides).
  'notice.blockedBlock': {
    ru: 'Это действие нельзя применить к уже изменённому блоку — сначала сохраните и переоткройте файл',
    en: 'This action can’t apply to an already-edited block — save and reopen the file first',
  },
  'notice.opRejected': { ru: 'Действие отменено', en: 'Action couldn’t be applied' },

  // --- shell renderer (start screen + titlebar) -------------------------------
  'shell.tagline': {
    ru: 'Откройте файл. Кликните в текст. Пишите.',
    en: 'Open a file. Click into the text. Write.',
  },
  'shell.dropPrefix': { ru: 'Перетащите файл сюда — или ', en: 'Drop a file here — or ' },
  'shell.newFile': { ru: 'Новый файл', en: 'New file' },
  'shell.recent': { ru: 'Недавние', en: 'Recent' },
  'shell.modePreview': { ru: 'Просмотр', en: 'Preview' },
  'shell.openTooltip': { ru: 'Открыть… (⌘O)', en: 'Open… (⌘O)' },
  'shell.findTooltip': { ru: 'Найти (⌘F)', en: 'Find (⌘F)' },
  'shell.findPlaceholder': { ru: 'Найти…', en: 'Find…' },
  'shell.findPrev': { ru: 'Предыдущее совпадение', en: 'Previous match' },
  'shell.findNext': { ru: 'Следующее совпадение', en: 'Next match' },
  'shell.findClose': { ru: 'Закрыть поиск', en: 'Close find' },
  'shell.undoTooltip': { ru: 'Отменить (⌘Z)', en: 'Undo (⌘Z)' },
  'shell.redoTooltip': { ru: 'Повторить (⇧⌘Z)', en: 'Redo (⇧⌘Z)' },
  'shell.previewTooltip': { ru: 'Просмотр (⌘E)', en: 'Preview (⌘E)' },
  'shell.pdfTooltip': { ru: 'Экспорт в PDF… (⇧⌘E)', en: 'Export to PDF… (⇧⌘E)' },
  'shell.saveTooltip': { ru: 'Сохранить (⌘S)', en: 'Save (⌘S)' },
  'shell.dirtyTooltip': { ru: 'Есть несохранённые изменения', en: 'Unsaved changes' },
  'shell.themeSystem': { ru: 'Тема: системная', en: 'Theme: system' },
  'shell.themeLight': { ru: 'Тема: светлая', en: 'Theme: light' },
  'shell.themeDark': { ru: 'Тема: тёмная', en: 'Theme: dark' },
  'shell.updateAvailable': { ru: 'Доступна v{version}', en: 'v{version} available' },
  'shell.updateTooltip': {
    ru: 'Вышла новая версия — открыть страницу загрузки',
    en: 'A new version is out — open the download page',
  },
  'shell.updateHide': { ru: 'Скрыть', en: 'Hide' },

  // --- doc editing overlay -----------------------------------------------------
  // New-file starter: placeholder shown in the empty first heading (⌘N).
  'doc.newHeadingPlaceholder': { ru: 'Заголовок', en: 'Heading' },
  'overlay.drag': { ru: 'Перетащить блок', en: 'Drag block' },
  'overlay.duplicate': { ru: 'Дублировать блок', en: 'Duplicate block' },
  'overlay.delete': { ru: 'Удалить блок', en: 'Delete block' },
  'overlay.replaceImage': { ru: 'Заменить картинку', en: 'Replace image' },
  'toolbar.bold': { ru: 'Жирный', en: 'Bold' },
  'toolbar.italic': { ru: 'Курсив', en: 'Italic' },
  'toolbar.underline': { ru: 'Подчёркнутый', en: 'Underline' },
  'toolbar.strikethrough': { ru: 'Зачёркнутый', en: 'Strikethrough' },
  'toolbar.spoiler': { ru: 'Спойлер', en: 'Spoiler' },
  'toolbar.code': { ru: 'Код', en: 'Code' },
  'toolbar.link': { ru: 'Ссылка', en: 'Link' },
  'panel.more': { ru: 'Ещё форматирование', en: 'More formatting' },
  'panel.turnInto': { ru: 'Превратить блок', en: 'Turn into' },
  'panel.moreFormat': { ru: 'Ещё форматирование', en: 'More formatting' },
  'panel.h1': { ru: 'Заголовок 1', en: 'Heading 1' },
  'panel.h2': { ru: 'Заголовок 2', en: 'Heading 2' },
  'panel.h3': { ru: 'Заголовок 3', en: 'Heading 3' },
  'panel.text': { ru: 'Обычный текст', en: 'Text' },
  'panel.bullet': { ru: 'Маркированный список', en: 'Bulleted list' },
  'panel.numbered': { ru: 'Нумерованный список', en: 'Numbered list' },
  'panel.task': { ru: 'Чек-лист', en: 'To-do list' },
  'panel.quote': { ru: 'Цитата', en: 'Quote' },
  'panel.code': { ru: 'Код-блок', en: 'Code block' },
  'panel.divider': { ru: 'Разделитель', en: 'Divider' },
  'panel.highlight': { ru: 'Выделение', en: 'Highlight' },
  'panel.superscript': { ru: 'Степень', en: 'Superscript' },
  'panel.subscript': { ru: 'Индекс', en: 'Subscript' },
  'panel.spoiler': { ru: 'Спойлер', en: 'Spoiler' },
  'toolbar.linkPlaceholder': { ru: 'Адрес ссылки', en: 'Link URL' },
  'toolbar.removeLink': { ru: 'Убрать ссылку', en: 'Remove link' },
} as const satisfies Record<string, { ru: string; en: string }>;

export type StringKey = keyof typeof STRINGS;
export type Translate = (key: StringKey) => string;

export function makeT(lang: Lang): Translate {
  return (key) => {
    const entry = (STRINGS as Record<string, { ru: string; en: string } | undefined>)[key];
    return entry ? entry[lang] : key; // untyped callers degrade to the key, never throw
  };
}
