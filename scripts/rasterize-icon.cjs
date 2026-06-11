// Rasterize design/icons/redra.svg to a 1024px PNG with a REAL alpha
// channel, using Electron's offscreen renderer (already a dev dependency).
// qlmanage flattens SVG onto a white background, which destroys the
// transparent margins the Apple Big Sur icon grid requires.
//
// usage: electron scripts/rasterize-icon.cjs <in.svg> <out.png>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const [svgPath, outPath] = process.argv.slice(2);
if (!svgPath || !outPath) {
  console.error('usage: electron rasterize-icon.cjs <in.svg> <out.png>');
  process.exit(1);
}

app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true },
    });
    // The SVG is loaded as the top-level document: its own canvas is
    // transparent, and a data:-page <img src="file://…"> would be blocked
    // by the origin policy anyway. The root <svg> is sized 1024×1024, the
    // window matches, so the capture is 1:1.
    await win.loadURL(pathToFileURL(path.resolve(svgPath)).href);
    // One settled frame so the decoded image is actually composited.
    await new Promise((r) => setTimeout(r, 300));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(outPath, image.toPNG());
    app.exit(0);
  } catch (err) {
    console.error('rasterize failed:', err);
    app.exit(1);
  }
});

// Never hang the icon build.
setTimeout(() => {
  console.error('rasterize timed out');
  app.exit(1);
}, 20000);
