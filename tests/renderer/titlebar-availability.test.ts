// @vitest-environment jsdom
//
// Drives the real shell renderer (src/renderer/main.ts) against a mocked
// window.redra to assert the titlebar undo/redo VISIBILITY contract:
//
//   • opening a document does NOT reveal undo/redo (empty history)
//   • the doc-only actions (find/preview/pdf/save) DO appear on open
//   • onEditAvailability toggles undo/redo via `hidden`, not `disabled`
//
// main.ts runs top-level on import, so we build the DOM from the shipped
// index.html, stub the CSS import, capture the registered callbacks, then
// import the module once and invoke the captured callbacks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { EditAvailability, DocOpenedInfo } from '../../src/shared/ipc.js';

// The CSS import has no transformer under bare vitest — stub it to nothing.
vi.mock('../../src/renderer/style.css', () => ({}));

// vitest runs from the project root.
const indexHtml = readFileSync(
  join(process.cwd(), 'src/renderer/index.html'),
  'utf8',
);
// Pull just the <body>… innerHTML so the titlebar markup is present, minus the
// <script type=module> that would otherwise try to load main.ts a second time.
const bodyInner = indexHtml
  .replace(/^[\s\S]*<body[^>]*>/i, '')
  .replace(/<\/body>[\s\S]*$/i, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '');

// Captured renderer callbacks.
let onDocOpened!: (info: DocOpenedInfo) => void;
let onEditAvailability!: (state: EditAvailability) => void;

const id = (s: string): HTMLButtonElement =>
  document.getElementById(s) as HTMLButtonElement;

beforeAll(async () => {
  document.body.dataset['state'] = 'start';
  document.body.innerHTML = bodyInner;

  // A redra stub: on* handlers stash the callback; promise methods resolve.
  const redra = {
    onDocOpened: (cb: (i: DocOpenedInfo) => void) => (onDocOpened = cb),
    onDocRenamed: () => {},
    onEditAvailability: (cb: (s: EditAvailability) => void) => (onEditAvailability = cb),
    onDirtyChanged: () => {},
    onModeChanged: () => {},
    newFile: () => Promise.resolve(),
    copyTelegram: () => {},
    onNotice: () => {},
    onUpdateAvailable: () => {},
    onFindOpen: () => {},
    onFindResult: () => {},
    getSettings: () => Promise.resolve({ shellTheme: 'system' }),
    setSettings: () => Promise.resolve({ shellTheme: 'system' }),
    getRecents: () => Promise.resolve([]),
    undo: () => {},
    redo: () => {},
    tipShow: () => {},
    tipHide: () => {},
    togglePreview: () => {},
    save: () => Promise.resolve(),
    exportPdf: () => Promise.resolve(),
    openFileDialog: () => Promise.resolve(),
    openPath: () => Promise.resolve(),
    pathForFile: () => '',
    findStart: () => {},
    findNext: () => {},
    findStop: () => {},
    openUpdate: () => {},
    dismissUpdate: () => {},
  };
  (window as unknown as { redra: unknown }).redra = redra;

  await import('../../src/renderer/main.js');
  // let the getSettings()/getRecents() microtasks flush
  await Promise.resolve();
});

const openDoc = (): void =>
  onDocOpened({ name: 'report.html', path: '/tmp/report.html', format: 'html' } as DocOpenedInfo);

describe('titlebar undo/redo visibility', () => {
  it('a freshly opened document hides undo AND redo', () => {
    openDoc();
    expect(id('btn-undo').hidden).toBe(true);
    expect(id('btn-redo').hidden).toBe(true);
  });

  it('opening a document DOES reveal the other doc-only actions', () => {
    openDoc();
    for (const b of ['btn-find', 'btn-preview', 'btn-pdf', 'btn-save']) {
      expect(id(b).hidden).toBe(false);
    }
  });

  it('the first edit (canUndo) reveals Undo; Redo stays hidden', () => {
    openDoc();
    onEditAvailability({ canUndo: true, canRedo: false });
    expect(id('btn-undo').hidden).toBe(false);
    expect(id('btn-redo').hidden).toBe(true);
  });

  it('an undo that enables redo reveals Redo', () => {
    openDoc();
    onEditAvailability({ canUndo: false, canRedo: true });
    expect(id('btn-redo').hidden).toBe(false);
    expect(id('btn-undo').hidden).toBe(true);
  });

  it('availability toggles VISIBILITY (hidden), never disabled', () => {
    openDoc();
    onEditAvailability({ canUndo: true, canRedo: true });
    // hidden is the contract; disabled must not be the mechanism used here
    expect(id('btn-undo').hidden).toBe(false);
    expect(id('btn-undo').disabled).toBe(false);
    onEditAvailability({ canUndo: false, canRedo: false });
    expect(id('btn-undo').hidden).toBe(true);
    expect(id('btn-redo').hidden).toBe(true);
  });
});

describe('titlebar tooltips: custom pill, aria-label is the text source', () => {
  it('icon buttons carry a localized aria-label and NO native title', () => {
    const open = id('btn-open');
    // The hint lives in aria-label; native `title` is dead in the drag region,
    // so we no longer set it (a left-over title would be a misleading no-op).
    expect(open.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
    expect(open.title).toBe('');
  });

  it('mounts the start-screen tooltip pill, hidden until hover', () => {
    const pill = document.getElementById('tb-tip');
    expect(pill).not.toBeNull();
    expect(pill!.classList.contains('visible')).toBe(false);
  });
});
