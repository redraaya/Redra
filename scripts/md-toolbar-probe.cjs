// Real-Chromium proof of the new md quick-toolbar actions. jsdom has no
// execCommand, so what underline/strikeThrough actually emit — and whether the
// spoiler insertHTML lands — must be checked here. Run: npx electron scripts/md-toolbar-probe.cjs
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `data:text/html,<body><p id="p" contenteditable="true">hello world</p><script>
  const p = document.getElementById('p');
  function selectWord(){ const r=document.createRange(); const t=p.firstChild;
    r.setStart(t,0); r.setEnd(t,5); const s=getSelection(); s.removeAllRanges(); s.addRange(r); }
  window.__u = () => { selectWord(); document.execCommand('underline'); return p.innerHTML; };
  window.__s = () => { p.innerHTML='hello world'; selectWord(); document.execCommand('strikeThrough'); return p.innerHTML; };
  window.__sp = () => { p.innerHTML='hello world'; selectWord();
    const ok = document.execCommand('insertHTML', false, '<tg-spoiler>hello</tg-spoiler>'); return p.innerHTML + ' :: ok=' + ok; };
<\/script></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 300 });
  const wc = win.webContents;
  await wc.loadURL(PAGE);
  await sleep(200);
  console.log('UNDERLINE >>>', JSON.stringify(await wc.executeJavaScript('window.__u()')));
  console.log('STRIKE    >>>', JSON.stringify(await wc.executeJavaScript('window.__s()')));
  console.log('SPOILER   >>>', JSON.stringify(await wc.executeJavaScript('window.__sp()')));
  app.exit(0);
});
