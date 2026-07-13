// Real-Chromium proof of the MD 2.0 whole-document editing model. jsdom has no
// execCommand/caret, so the native behaviours the model rests on are pinned
// here: Enter in a list makes a new <li>, Enter on an empty item exits the
// list, insertOrderedList over three paragraphs makes THREE items, formatBlock
// toggles headings/quotes/pre, insertHorizontalRule works, a checkbox with
// contenteditable=false stays clickable inside the editable, and typing fires
// 'input' on the host. Run: npx electron scripts/md-editing-probe.cjs
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `data:text/html,<body><main contenteditable="true"><h1>H</h1><p id="a">first</p><p id="b">second</p><p id="c">third</p><ol id="list"><li id="li1">one</li></ol><ul id="tasks"><li class="md-task"><input type="checkbox" contenteditable="false" tabindex="-1"> task</li></ul></main><script>
  const main = document.querySelector('main');
  document.execCommand('defaultParagraphSeparator', false, 'p');
  let inputs = 0; main.addEventListener('input', () => inputs++);
  function caretEnd(el){ const r=document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r); }
  function selectEls(a,b){ const r=document.createRange(); r.setStartBefore(a); r.setEndAfter(b);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r); }
  window.__enterInLi = () => { caretEnd(document.getElementById('li1'));
    document.execCommand('insertParagraph');
    return document.getElementById('list').querySelectorAll('li').length; };
  window.__enterEmptyLi = () => { const list=document.getElementById('list');
    const items=list.querySelectorAll('li'); caretEnd(items[items.length-1]);
    document.execCommand('insertParagraph'); // empty item -> exits the list
    return list.querySelectorAll('li').length + ':' + (list.nextElementSibling ? list.nextElementSibling.tagName : 'none'); };
  window.__listFromLines = () => { selectEls(document.getElementById('a'), document.getElementById('c'));
    document.execCommand('insertOrderedList');
    const ols = main.querySelectorAll('ol');
    return Array.from(ols).map(o=>o.querySelectorAll('li').length).join('/'); };
  window.__formatH1 = () => { caretEnd(document.getElementById('b')||main.querySelector('li'));
    document.execCommand('formatBlock', false, '<h1>');
    const sel = getSelection().anchorNode; const el = sel.nodeType===1?sel:sel.parentElement;
    return el.closest('h1') ? 'h1' : 'no'; };
  window.__formatQuotePre = () => { document.execCommand('formatBlock', false, '<blockquote>');
    const q = getSelection().anchorNode.parentElement.closest('blockquote') ? 'q' : 'noq';
    document.execCommand('formatBlock', false, '<pre>');
    const p = getSelection().anchorNode.parentElement.closest('pre') ? 'pre' : 'nopre';
    return q + '+' + p; };
  window.__hr = () => { const before = main.querySelectorAll('hr').length;
    document.execCommand('insertHorizontalRule'); return main.querySelectorAll('hr').length - before; };
  window.__checkbox = () => { const box = main.querySelector('input[type=checkbox]');
    box.click(); return box.checked ? 'toggles' : 'inert'; };
  window.__typing = () => { caretEnd(main.querySelector('p') || main);
    const before = inputs; document.execCommand('insertText', false, 'x');
    return (inputs > before) ? 'input-fires' : 'silent'; };
  window.__undoable = () => document.queryCommandEnabled('undo');
<\/script></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const wc = win.webContents;
  await wc.loadURL(PAGE);
  await sleep(200);
  console.log('ENTER-IN-LI      >>>', await wc.executeJavaScript('window.__enterInLi()'), '(expect 2)');
  console.log('ENTER-EMPTY-LI   >>>', await wc.executeJavaScript('window.__enterEmptyLi()'), '(expect 1:P — the empty item leaves the list, a P follows)');
  console.log('LIST-FROM-LINES  >>>', await wc.executeJavaScript('window.__listFromLines()'), '(expect 3 items in one ol)');
  console.log('FORMAT-H1        >>>', await wc.executeJavaScript('window.__formatH1()'), '(expect h1)');
  console.log('FORMAT-QUOTE+PRE >>>', await wc.executeJavaScript('window.__formatQuotePre()'), '(expect q+pre)');
  console.log('INSERT-HR        >>>', await wc.executeJavaScript('window.__hr()'), '(expect 1)');
  console.log('CHECKBOX-IN-CE   >>>', await wc.executeJavaScript('window.__checkbox()'), '(expect toggles)');
  console.log('TYPING-INPUT     >>>', await wc.executeJavaScript('window.__typing()'), '(expect input-fires)');
  console.log('UNDO-ENABLED     >>>', await wc.executeJavaScript('window.__undoable()'), '(expect true)');
  app.exit(0);
});
