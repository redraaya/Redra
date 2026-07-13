import { app, nativeImage, nativeTheme } from 'electron';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, WebContentsView } from 'electron';

/**
 * Hidden `--screenshot <out.png>` mode for generating README screenshots —
 * gated like --smoke and deliberately undocumented. With a document on the
 * CLI it captures the full window (shell strip + doc view composited, hover
 * handle synthesized over the document); without one — the start screen.
 */
export class ScreenshotHarness {
  constructor(
    private readonly outPath: string | null,
    /** Select this text in the doc before capturing (shows the toolbar). */
    private readonly findText: string | null = null,
    /** Open the slash menu in a fresh empty paragraph before capturing. */
    private readonly slash: boolean = false,
  ) {
    if (this.outPath !== null) {
      // Light theme regardless of system setting, and a throwaway userData —
      // the user's real recents must never leak into a published screenshot.
      nativeTheme.themeSource = 'light';
      app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'redra-shot-')));
    }
  }

  get enabled(): boolean {
    return this.outPath !== null;
  }

  /** Call once startup settled (start screen painted / document served). */
  schedule(
    getWin: () => BrowserWindow | null,
    getDocView: () => WebContentsView | null,
    withDoc: boolean,
  ): void {
    const outPath = this.outPath;
    if (outPath === null) return;
    setTimeout(() => {
      void this.capture(outPath, getWin(), getDocView(), withDoc).catch((err: unknown) => {
        console.error('[shot] failed:', err);
        app.exit(1);
      });
    }, 1500);
    // Never hang the screenshot build.
    setTimeout(() => {
      console.error('[shot] timed out');
      app.exit(1);
    }, 20_000);
  }

  private async capture(
    outPath: string,
    win: BrowserWindow | null,
    docView: WebContentsView | null,
    withDoc: boolean,
  ): Promise<void> {
    if (!win) throw new Error('no window');

    let image = await win.webContents.capturePage();

    if (withDoc) {
      if (!docView) throw new Error('no doc view');
      // Synthesize hover so the block handle is visible on the shot.
      const { width } = docView.getBounds();
      docView.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(width / 2),
        y: 140,
      });
      if (this.findText !== null) {
        // Select the first match — the preload's selection toolbar pops over
        // it exactly as it would for a user drag (selectionchange is shared).
        await docView.webContents.executeJavaScript(
          `window.find(${JSON.stringify(this.findText)}); void 0;`,
        );
      }
      if (this.slash) {
        // A fresh empty paragraph + a "/" keydown: the md controller's slash
        // menu opens the same way it does for a real keystroke.
        await docView.webContents.executeJavaScript(`(() => {
          const main = document.querySelector('main');
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          main.appendChild(p);
          const r = document.createRange();
          r.selectNodeContents(p);
          r.collapse(true);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
        })(); void 0;`);
      }
      await new Promise((r) => setTimeout(r, 400));
      // The doc view is a separate WebContentsView: the shell capture shows
      // only the strip above it — composite the two captures by rows (BGRA).
      const shellImg = await win.webContents.capturePage();
      const docImg = await docView.webContents.capturePage();
      const sw = shellImg.getSize().width;
      if (docImg.getSize().width !== sw) {
        throw new Error(`width mismatch: shell ${sw}, doc ${docImg.getSize().width}`);
      }
      const scale = sw / (win.getContentSize()[0] ?? sw);
      const stripRows = shellImg.getSize().height - docImg.getSize().height;
      const rowBytes = sw * 4;
      const out = Buffer.concat([
        shellImg.toBitmap().subarray(0, stripRows * rowBytes),
        docImg.toBitmap(),
      ]);
      image = nativeImage.createFromBitmap(out, {
        width: sw,
        height: stripRows + docImg.getSize().height,
        scaleFactor: scale,
      });
    }

    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, image.toPNG());
    console.log('[shot] written:', outPath);
    setTimeout(() => app.exit(0), 100);
  }
}
