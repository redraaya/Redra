/**
 * Default reading theme for rendered Markdown documents (Stage 4).
 *
 * A .md file carries no CSS of its own, so Redra supplies one — the theme
 * approved in design/mockups/markdown-mode.html: warm paper, serif body,
 * SF headings with tight tracking (kin to the shell), a quiet gray quote
 * bar (never the accent), code chips, de-emphasized tables. Embedded in the
 * document <head> (not insertCSS) with NO @media-screen wrapper, so it
 * prints into the PDF export unchanged. Light + dark via prefers-color-scheme,
 * overridable by the viewer if the shell ever stamps data-theme.
 */
export const MD_THEME = `
:root{
  --d-paper:#fbfaf7; --d-ink:#26241f; --d-muted:#7b776c; --d-line:rgba(38,36,31,.10);
  --d-link:#b4532f; --d-code-bg:#f1efe8; --d-code-bd:rgba(38,36,31,.08);
  --d-quote:#d9d5ca; --d-mark:#f6e7a3; --d-sel:#f4dcc8; --d-chip:#efede6;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme=light]){
    --d-paper:#191816; --d-ink:#e7e5df; --d-muted:#8f8b81; --d-line:rgba(231,229,223,.12);
    --d-link:#e0906a; --d-code-bg:#22211d; --d-code-bd:rgba(231,229,223,.09);
    --d-quote:#403d36; --d-mark:#57491f; --d-sel:#4a3527; --d-chip:#24231f;
  }
}
:root[data-theme=dark]{
  --d-paper:#191816; --d-ink:#e7e5df; --d-muted:#8f8b81; --d-line:rgba(231,229,223,.12);
  --d-link:#e0906a; --d-code-bg:#22211d; --d-code-bd:rgba(231,229,223,.09);
  --d-quote:#403d36; --d-mark:#57491f; --d-sel:#4a3527; --d-chip:#24231f;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:var(--d-paper); color:var(--d-ink);
  font-family:"Iowan Old Style",Palatino,"Palatino Linotype",Georgia,serif;
  font-size:17px; line-height:1.72; -webkit-font-smoothing:antialiased;
}
main{max-width:680px; margin:0 auto; padding:52px 24px 72px}
::selection{background:var(--d-sel)}
h1,h2,h3,h4,h5,h6{
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,sans-serif;
  color:var(--d-ink); line-height:1.2;
}
h1{font-size:34px;font-weight:700;letter-spacing:-.024em;margin:0 0 18px}
h2{font-size:23px;font-weight:650;letter-spacing:-.018em;margin:34px 0 12px}
h3{font-size:18px;font-weight:600;letter-spacing:-.01em;margin:26px 0 8px}
h4{font-size:15.5px;font-weight:600;margin:22px 0 6px}
h5,h6{font-size:14px;font-weight:600;color:var(--d-muted);margin:20px 0 6px}
p{margin:0 0 16px}
a{color:var(--d-link);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2.5px}
hr{border:none;border-top:1px solid var(--d-line);margin:30px 0}
strong{font-weight:650}
u,ins{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
s,del{text-decoration:line-through}
mark{background:var(--d-mark);color:inherit;border-radius:3px;padding:0 3px}
sub,sup{font-size:.72em;line-height:0}
tg-spoiler{background:var(--d-quote);border-radius:3px;filter:blur(4.5px);cursor:pointer;transition:filter .18s ease}
tg-spoiler:hover{filter:blur(0)}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em;
  background:var(--d-code-bg);border:1px solid var(--d-code-bd);border-radius:5px;padding:1px 5px}
pre{background:var(--d-code-bg);border:1px solid var(--d-code-bd);border-radius:9px;
  padding:14px 16px;margin:0 0 18px;overflow-x:auto}
pre code{background:none;border:none;padding:0;font-size:13.5px;line-height:1.6;display:block}
pre.md-math{font-style:italic}
.md-math{font-style:italic}
blockquote{border-left:3px solid var(--d-quote);margin:0 0 16px;padding:2px 0 2px 18px}
blockquote > :last-child{margin-bottom:0}
details{border-left:3px solid var(--d-quote);padding:2px 0 2px 18px;margin:0 0 16px}
summary{cursor:pointer;font-weight:600;color:var(--d-ink);
  font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px}
summary::marker{color:var(--d-muted)}
details > :not(summary):first-of-type{margin-top:8px}
ul,ol{margin:0 0 16px;padding-left:26px}
li{margin-bottom:7px}
li::marker{color:var(--d-muted)}
li.md-task{list-style:none;margin-left:-22px}
li.md-task::before{content:"";display:inline-block;width:15px;height:15px;margin-right:9px;
  border:1.5px solid var(--d-muted);border-radius:4.5px;vertical-align:-2px}
li.md-task-done{color:var(--d-muted)}
li.md-task-done::before{background:var(--d-link);border-color:var(--d-link)}
table{border-collapse:collapse;width:100%;margin:0 0 18px;font-size:14.5px;display:block;overflow-x:auto}
th{font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:11.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--d-muted);font-weight:600;text-align:left;
  padding:7px 12px;border-bottom:1.5px solid var(--d-line);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--d-line)}
td.al-c,th.al-c{text-align:center}
td.al-r,th.al-r{text-align:right;font-variant-numeric:tabular-nums}
img{max-width:100%;height:auto;border-radius:8px;margin:6px 0 22px}
.md-fnref{color:var(--d-link);font-size:.72em;vertical-align:super}
.md-footnote{color:var(--d-muted);font-size:14px;border-top:1px solid var(--d-line);
  padding-top:8px;margin-top:20px}
.md-footnote-label{color:var(--d-link);margin-right:6px}
[data-redra-readonly]{position:relative}
@media print{
  body{background:#fff}
  main{max-width:none;padding:0}
  pre,table{overflow:visible}
}
`;
