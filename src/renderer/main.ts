import type { RedraShellApi } from '../shared/ipc';
import './style.css';

declare global {
  interface Window {
    redra: RedraShellApi;
  }
}

const redra = window.redra;
const stripTitle = document.getElementById('strip-title')!;
const openBtn = document.getElementById('open-btn')!;
const recentsEl = document.getElementById('recents')!;

openBtn.addEventListener('click', () => {
  void redra.openFileDialog();
});

// Drag-and-drop: forward the dropped file's path to main over IPC.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag-over');
});
window.addEventListener('dragleave', () => document.body.classList.remove('drag-over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (!file || !/\.html?$/i.test(file.name)) return;
  void redra.openPath(redra.pathForFile(file));
});

redra.onDocOpened((info) => {
  stripTitle.textContent = `${info.name} — Redra`;
  void renderRecents();
});

redra.onDirtyChanged((state) => {
  // Always clean until Stage 3; the wiring is what matters here.
  console.log('[shell] dirty:', state.dirty);
});

async function renderRecents(): Promise<void> {
  const list = await redra.getRecents();
  recentsEl.replaceChildren(
    ...list.map((p) => {
      const li = document.createElement('li');
      li.textContent = p;
      li.title = p;
      li.addEventListener('click', () => void redra.openPath(p));
      return li;
    }),
  );
}

void renderRecents();
