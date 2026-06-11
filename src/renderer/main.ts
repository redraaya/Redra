import type { RecentEntry, RedraShellApi, Settings } from '../shared/ipc';
import { makeT, pickLang } from '../shared/i18n';
import { formatRelativeTime } from '../shared/relative-time';
import './style.css';

declare global {
  interface Window {
    redra: RedraShellApi;
  }
}

const redra = window.redra;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const titleApp = $('title-app');
const titleDoc = $('title-doc');
const docName = $('doc-name');
const dirtyDot = $('dirty-dot');
const modePill = $('mode-pill');
const updatePill = $('update-pill');
const updateText = $('update-text');
const updateClose = $('update-close') as HTMLButtonElement;
const btnPreview = $('btn-preview') as HTMLButtonElement;
const btnPdf = $('btn-pdf') as HTMLButtonElement;
const btnSave = $('btn-save') as HTMLButtonElement;
const btnTheme = $('btn-theme') as HTMLButtonElement;
const recentBlock = $('recent-block');
const recentsEl = $('recents');

// --- language -----------------------------------------------------------------

// Electron derives navigator.language from the system locale: RU system → RU
// shell, anything else → EN. index.html ships Russian defaults; non-RU locales
// are re-labeled here, synchronously, before first paint.
const lang = pickLang(navigator.language);
const t = makeT(lang);

modePill.textContent = t('shell.modePreview');
btnPreview.title = t('shell.previewTooltip');
btnPdf.title = t('shell.pdfTooltip');
btnSave.title = t('shell.saveTooltip');
dirtyDot.title = t('shell.dirtyTooltip');
updatePill.title = t('shell.updateTooltip');
updateClose.title = t('shell.updateHide');
updateClose.setAttribute('aria-label', t('shell.updateHide'));
{
  const tagline = document.querySelector('.tagline');
  if (tagline) tagline.textContent = t('shell.tagline');
  const recentLabel = document.querySelector('.recent-label');
  if (recentLabel) recentLabel.textContent = t('shell.recent');
  const dropPill = document.getElementById('drop-pill');
  if (dropPill) {
    const hotkey = document.createElement('b');
    hotkey.textContent = '⌘O';
    dropPill.replaceChildren(t('shell.dropPrefix'), hotkey);
  }
}

// --- theme ------------------------------------------------------------------

const THEME_ORDER: Settings['shellTheme'][] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<Settings['shellTheme'], string> = {
  system: t('shell.themeSystem'),
  light: t('shell.themeLight'),
  dark: t('shell.themeDark'),
};
let shellTheme: Settings['shellTheme'] = 'system';

function applyTheme(theme: Settings['shellTheme']): void {
  shellTheme = theme;
  if (theme === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = theme;
  btnTheme.title = THEME_LABEL[theme];
  for (const t of THEME_ORDER) {
    $(`theme-icon-${t}`).hidden = t !== theme;
  }
}

btnTheme.addEventListener('click', () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(shellTheme) + 1) % THEME_ORDER.length]!;
  applyTheme(next);
  void redra.setSettings({ shellTheme: next });
});

void redra.getSettings().then((s) => applyTheme(s.shellTheme));

// --- titlebar actions ---------------------------------------------------------

btnPreview.addEventListener('click', () => redra.togglePreview());
btnPdf.addEventListener('click', () => void redra.exportPdf());
btnSave.addEventListener('click', () => void redra.save());

// --- document state -----------------------------------------------------------

redra.onDocOpened((info) => {
  document.body.dataset['state'] = 'doc';
  titleApp.hidden = true;
  titleDoc.hidden = false;
  docName.textContent = info.name;
  // Start screen → doc state: theme button yields to the document actions.
  btnTheme.hidden = true;
  for (const b of [btnPreview, btnPdf, btnSave]) b.hidden = false;
  void renderRecents();
});

redra.onDirtyChanged((state) => {
  dirtyDot.hidden = !state.dirty;
  // Subtle disabled look when there is nothing to save.
  btnSave.disabled = !state.dirty;
});

redra.onModeChanged((state) => {
  // The pill is visible while «Просмотр» (preview) is on, i.e. editing off.
  modePill.hidden = state.editing;
  btnPreview.classList.toggle('active', !state.editing);
});

// --- update pill ----------------------------------------------------------------

// Quiet by design: shows up only when main says a newer release exists,
// visible in both start and doc states, gone for good after ✕.
let updateInfo: { version: string; url: string } | null = null;

redra.onUpdateAvailable((info) => {
  updateInfo = info;
  updateText.textContent = t('shell.updateAvailable').replace('{version}', info.version);
  updatePill.hidden = false;
});

updatePill.addEventListener('click', () => {
  if (updateInfo) redra.openUpdate(updateInfo.url);
});

updateClose.addEventListener('click', (e) => {
  e.stopPropagation(); // the pill itself opens the release page
  if (updateInfo) redra.dismissUpdate(updateInfo.version);
  updatePill.hidden = true;
});

// --- drag-and-drop (whole window) ----------------------------------------------

// Enter/leave counter: dragleave fires on every child boundary, so a bare
// listener makes the highlight flicker while moving over the start screen.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('drag-over');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('drag-over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (!file || !/\.html?$/i.test(file.name)) return;
  void redra.openPath(redra.pathForFile(file));
});

// --- recents -------------------------------------------------------------------

const FILE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14 3v4a1 1 0 0 0 1 1h4" />' +
  '<path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />' +
  '<path d="M9 9h1" /><path d="M9 13h6" /><path d="M9 17h6" /></svg>';

function recentRow(entry: RecentEntry, now: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.title = entry.path;
  row.innerHTML = FILE_ICON_SVG;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = entry.name;
  const dir = document.createElement('div');
  dir.className = 'path';
  dir.textContent = entry.dir;
  meta.append(name, dir);
  row.append(meta);

  if (entry.openedAt !== undefined) {
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = formatRelativeTime(entry.openedAt, now, lang);
    row.append(when);
  }

  row.addEventListener('click', () => void redra.openPath(entry.path));
  return row;
}

async function renderRecents(): Promise<void> {
  const list = await redra.getRecents();
  recentBlock.hidden = list.length === 0;
  const now = Date.now();
  recentsEl.replaceChildren(...list.map((e) => recentRow(e, now)));
}

void renderRecents();
