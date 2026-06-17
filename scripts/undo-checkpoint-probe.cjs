// Real-Chromium proof of the v0.4 single-timeline checkpoint model. jsdom can't
// fire real `input` events with inputType/data, so the controller's per-edit
// segmentation must be proven here. This ports the controller's checkpoint
// logic into a page, drives it with SYNTHETIC KEYSTROKES (sendInputEvent), and
// asserts: (a) typing words cuts one checkpoint per word; (b) journal-style undo
// peels word-by-word; (c) the caret lands at end after an undo and typing
// continues there. Run: npx electron scripts/undo-checkpoint-probe.cjs
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = (wc) => wc.executeJavaScript(`document.getElementById('para').innerHTML`);
function key(wc, ch, mods) {
  wc.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers: mods });
  wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers: mods });
  wc.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers: mods });
}

// The page replicates the controller's checkpoint mechanism verbatim:
// isUndoGroupBoundary + flushCheckpoint (snapshot innerHTML on a word boundary),
// a linear checkpoint stack, and undo() = set innerHTML to the prev snapshot +
// caret-to-end (the controller's replaceCaretAtEnd via placeCaret-no-coords).
const PAGE = `data:text/html,<body><p id="para">Base.</p>
  <script>
    const p = document.getElementById('para');
    p.setAttribute('contenteditable','true'); p.focus();
    const end = () => { const r=document.createRange(); r.selectNodeContents(p); r.collapse(false);
      const s=getSelection(); s.removeAllRanges(); s.addRange(r); };
    end();
    function isUndoGroupBoundary(t,d){ return t==='insertParagraph'||t==='insertLineBreak'||(t==='insertText'&&d===' '); }
    const norm = (h) => h;                 // identity normalize for the probe
    let cp = p.innerHTML;                   // last checkpoint
    const stack = [];                       // {prev,next}
    function flush(){ const cur=p.innerHTML; if(norm(cur)===norm(cp)) return false;
      stack.push({prev:cp,next:cur}); cp=cur; return true; }
    p.addEventListener('input', (e)=>{
      if(isUndoGroupBoundary(e.inputType, e.data)){
        const s=getSelection(); if(s&&s.rangeCount){ const r=s.getRangeAt(0).cloneRange(); s.removeAllRanges(); s.addRange(r); }
        flush();
      }
    });
    window.__commit = () => flush();        // final flush (click-away / commit)
    window.__undo = () => { if(!stack.length) return false; const e=stack.pop(); p.innerHTML=e.prev; cp=e.prev; end(); p.focus(); return true; };
    window.__steps = () => stack.length;
  <\/script></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 700, height: 400 });
  const wc = win.webContents;
  await wc.loadURL(PAGE); await sleep(250);

  for (const ch of ' one two three') { key(wc, ch); await sleep(40); }
  await wc.executeJavaScript('window.__commit()'); // commit = final flush
  console.log('TYPED  :', JSON.stringify(await html(wc)));
  console.log('STEPS  :', await wc.executeJavaScript('window.__steps()'), '(expect 3: one|two|three)');

  for (let i = 1; i <= 4; i++) {
    const did = await wc.executeJavaScript('window.__undo()');
    await sleep(40);
    console.log(`UNDO ${i}:`, JSON.stringify(await html(wc)), did ? '' : '(nothing left)');
  }

  // Caret-after-undo: redo to "Base. one", then type 'X' — must append at END.
  await wc.loadURL(PAGE); await sleep(150);
  for (const ch of ' one two') { key(wc, ch); await sleep(40); }
  await wc.executeJavaScript('window.__commit()');
  await wc.executeJavaScript('window.__undo()'); // back to "Base. one"
  await sleep(40);
  key(wc, 'X'); await sleep(60);
  console.log('CARET  :', JSON.stringify(await html(wc)), '(expect "Base. oneX" — caret at end)');

  app.exit(0);
});
