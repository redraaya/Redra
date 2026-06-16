import type { RecentEntry, RedraShellApi, Settings } from '../shared/ipc';
import { makeT, pickLang } from '../shared/i18n';
import { formatRelativeTime } from '../shared/relative-time';
import { FindBarModel } from './find-bar';
import type { FindCommand } from './find-bar';
import { createNoticeToast } from './notice';
import { createTooltip } from './tooltip';
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
const btnUndo = $('btn-undo') as HTMLButtonElement;
const btnRedo = $('btn-redo') as HTMLButtonElement;
const btnPreview = $('btn-preview') as HTMLButtonElement;
const btnPdf = $('btn-pdf') as HTMLButtonElement;
const btnSave = $('btn-save') as HTMLButtonElement;
const btnTheme = $('btn-theme') as HTMLButtonElement;
const btnOpen = $('btn-open') as HTMLButtonElement;
const btnFind = $('btn-find') as HTMLButtonElement;
const findBar = $('find-bar');
const findInput = $('find-input') as HTMLInputElement;
const findCount = $('find-count');
const findPrev = $('find-prev') as HTMLButtonElement;
const findNext = $('find-next') as HTMLButtonElement;
const findClose = $('find-close') as HTMLButtonElement;
const recentBlock = $('recent-block');
const recentsEl = $('recents');
const dropPill = $('drop-pill') as HTMLButtonElement;

// --- language -----------------------------------------------------------------

// Electron derives navigator.language from the system locale: RU system → RU
// shell, anything else → EN. index.html ships Russian defaults; non-RU locales
// are re-labeled here, synchronously, before first paint.
const lang = pickLang(navigator.language);
const t = makeT(lang);

modePill.textContent = t('shell.modePreview');
// Titlebar .tb-btn icons carry their localized tooltip in data-tip (consumed
// by the custom tooltip module); the native `title` is deliberately absent so
// there is no slow double tooltip. The SAME localized string is mirrored into
// aria-label so the icon-only buttons keep an accessible name (data-tip alone
// is invisible to assistive tech).
const tipA11y = (btn: HTMLElement, text: string): void => {
  btn.dataset['tip'] = text;
  btn.setAttribute('aria-label', text);
};
tipA11y(btnPreview, t('shell.previewTooltip'));
tipA11y(btnUndo, t('shell.undoTooltip'));
tipA11y(btnRedo, t('shell.redoTooltip'));
tipA11y(btnOpen, t('shell.openTooltip'));
tipA11y(btnFind, t('shell.findTooltip'));
findInput.placeholder = t('shell.findPlaceholder');
findPrev.title = t('shell.findPrev');
findPrev.setAttribute('aria-label', t('shell.findPrev'));
findNext.title = t('shell.findNext');
findNext.setAttribute('aria-label', t('shell.findNext'));
findClose.title = t('shell.findClose');
findClose.setAttribute('aria-label', t('shell.findClose'));
tipA11y(btnPdf, t('shell.pdfTooltip'));
tipA11y(btnSave, t('shell.saveTooltip'));
dirtyDot.title = t('shell.dirtyTooltip');
updatePill.title = t('shell.updateTooltip');
updateClose.title = t('shell.updateHide');
updateClose.setAttribute('aria-label', t('shell.updateHide'));
{
  const tagline = document.querySelector('.tagline');
  if (tagline) tagline.textContent = t('shell.tagline');
  const recentLabel = document.querySelector('.recent-label');
  if (recentLabel) recentLabel.textContent = t('shell.recent');
  const hotkey = document.createElement('b');
  hotkey.textContent = '⌘O';
  dropPill.replaceChildren(t('shell.dropPrefix'), hotkey);
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
  // The theme button's tooltip is dynamic (system/light/dark) — update its
  // data-tip AND aria-label so both the custom tooltip and assistive tech
  // reflect the current cycle position.
  tipA11y(btnTheme, THEME_LABEL[theme]);
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

// Visible in BOTH states (start screen and doc) — the one always-there action.
btnOpen.addEventListener('click', () => void redra.openFileDialog());
btnUndo.addEventListener('click', () => redra.undo());
btnRedo.addEventListener('click', () => redra.redo());
btnPreview.addEventListener('click', () => redra.togglePreview());
btnPdf.addEventListener('click', () => void redra.exportPdf());
btnSave.addEventListener('click', () => void redra.save());

// Undo/redo availability streamed from the doc view (via main). Until the
// first event after a doc opens, both buttons stay disabled (set below).
redra.onEditAvailability((state) => {
  btnUndo.disabled = !state.canUndo;
  btnRedo.disabled = !state.canRedo;
});

// --- fast custom tooltips (titlebar icons only) ---------------------------------

// The native `title` is removed from these buttons (data-tip carries the text);
// the tooltip module shows a quick dark pill below the button instead. Only the
// titlebar .tb-btn icons — not the doc-view handle pill or B/I/<> toolbar.
const tooltip = createTooltip(document);
for (const b of [btnOpen, btnFind, btnUndo, btnRedo, btnPreview, btnPdf, btnSave, btnTheme]) {
  tooltip.attach(b);
}

// --- find in document (⌘F) ------------------------------------------------------

// Pure state in FindBarModel; this block only wires DOM + the redra API.
const findModel = new FindBarModel();

function runFindCommands(commands: FindCommand[]): void {
  for (const c of commands) {
    if (c.kind === 'start') redra.findStart(c.text);
    else if (c.kind === 'next') redra.findNext(c.text, c.forward);
    else redra.findStop();
  }
}

function syncFindBar(): void {
  findBar.hidden = !findModel.open;
  findCount.textContent = findModel.counter;
  btnFind.classList.toggle('active', findModel.open);
}

function openFindBar(): void {
  findModel.openBar();
  syncFindBar();
  findInput.focus();
  findInput.select(); // the kept query restarts on the next keystroke
}

function closeFindBar(): void {
  runFindCommands(findModel.close());
  syncFindBar();
}

btnFind.addEventListener('click', () => {
  if (findModel.open) closeFindBar();
  else openFindBar();
});

findInput.addEventListener('input', () => {
  runFindCommands(findModel.setText(findInput.value));
  syncFindBar();
});

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runFindCommands(findModel.step(!e.shiftKey));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
  }
});

findPrev.addEventListener('click', () => runFindCommands(findModel.step(false)));
findNext.addEventListener('click', () => runFindCommands(findModel.step(true)));
findClose.addEventListener('click', () => closeFindBar());

redra.onFindOpen(() => openFindBar());
redra.onFindResult((result) => {
  findModel.applyResult(result);
  syncFindBar();
});

// --- start screen: the drop pill doubles as «Open…» -----------------------------

dropPill.addEventListener('click', () => void redra.openFileDialog());

// --- document state -----------------------------------------------------------

redra.onDocOpened((info) => {
  document.body.dataset['state'] = 'doc';
  titleApp.hidden = true;
  titleDoc.hidden = false;
  docName.textContent = info.name;
  // New document content (open or version restore): a kept find query and
  // its counter would be stale — reset the bar (main already stopped the
  // native search on the doc view's navigation).
  findModel.reset();
  findInput.value = '';
  syncFindBar();
  // Start screen → doc state: theme button yields to the document actions.
  btnTheme.hidden = true;
  for (const b of [btnFind, btnUndo, btnRedo, btnPreview, btnPdf, btnSave]) b.hidden = false;
  // A fresh document has an empty history: both stay disabled until the doc
  // view's editing layer reports availability (it emits on arm + every change).
  btnUndo.disabled = true;
  btnRedo.disabled = true;
  void renderRecents();
});

redra.onDirtyChanged((state) => {
  dirtyDot.hidden = !state.dirty;
  // Subtle disabled look when there is nothing to save.
  btnSave.disabled = !state.dirty;
});

redra.onModeChanged((state) => {
  // The pill is visible while Preview is on, i.e. editing off.
  modePill.hidden = state.editing;
  btnPreview.classList.toggle('active', !state.editing);
});

// --- transient notice toast (rejected-op message from main) --------------------

const notice = createNoticeToast(document);
redra.onNotice((n) => notice.show(n.text));

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
