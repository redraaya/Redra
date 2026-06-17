// Final confirmation: replicate the controller's EXACT fix (onSessionInput
// boundary break) and undo via the EXACT app path (execCommand('undo'), what
// handleUndo calls during a session). Expect word-by-word steps.
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = (wc) => wc.executeJavaScript(`document.getElementById('para').innerHTML`);
function key(wc, ch, mods) {
  wc.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers: mods });
  wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers: mods });
  wc.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers: mods });
}
// isUndoGroupBoundary + selection touch, copied verbatim from the shipped code.
const PAGE = `data:text/html,<body><p id="para">The quick brown fox.</p>
  <script>
    const p=document.getElementById('para'); p.setAttribute('contenteditable','true'); p.focus();
    const r=document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r);
    function isUndoGroupBoundary(inputType, data){
      if(inputType==='insertParagraph'||inputType==='insertLineBreak') return true;
      return inputType==='insertText' && data===' ';
    }
    p.addEventListener('input', (e) => {
      if(!isUndoGroupBoundary(e.inputType, e.data)) return;
      const sel=getSelection(); if(!sel||sel.rangeCount===0) return;
      const rg=sel.getRangeAt(0).cloneRange(); sel.removeAllRanges(); sel.addRange(rg);
    });
  <\/script></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 700, height: 400 });
  const wc = win.webContents;
  await wc.loadURL(PAGE); await sleep(250);
  await (async () => { for (const ch of ' Hello world test') { key(wc, ch); await sleep(45); } })();
  console.log('TYPED :', JSON.stringify(await html(wc)));
  for (let i = 1; i <= 6; i++) {
    await wc.executeJavaScript(`document.execCommand('undo')`); // EXACT app path
    await sleep(70);
    console.log(`UNDO ${i}:`, JSON.stringify(await html(wc)));
  }
  app.exit(0);
});
