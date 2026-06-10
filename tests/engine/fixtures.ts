/**
 * Representative fixture: an AI-generated-style HTML report with embedded
 * style/script, comments, <pre>, entities, mixed attribute quoting, a table,
 * and a <template>.
 *
 * Note: per the HTML spec a newline immediately after the <pre> start tag is
 * dropped by the parser, so the fixture's <pre> content deliberately starts
 * with text, not a newline — inner newlines/indentation are what must survive.
 */

export const STYLE_TEXT = `
    body { font-family: "Segoe UI", sans-serif; margin: 0 auto; max-width: 960px; }
    .card > h2::before { content: "\\2014  "; color: #336699; }
    @media (max-width: 600px) { .grid { display: block !important; } }
  `;

export const SCRIPT_TEXT = `
    // entities & operators must survive byte-for-byte
    const threshold = 10;
    function check(a, b) {
      if (a < threshold && b > 0) {
        return 'a < threshold && b > 0';
      }
      return "no \\"match\\" found";
    }
    check(1 < 2 ? 3 : 4, 5);
  `;

export const COMMENT_TEXT = ' build:2026-06-10 | generator: ai-report v3 — do not edit ';

export const PRE_TEXT = `def fib(n):
    if n < 2:
        return n        # base case
    return fib(n - 1) + fib(n - 2)

print(fib(10))`;

export const REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quarterly Report &amp; Outlook</title>
<style>${STYLE_TEXT}</style>
</head>
<body>
<!--${COMMENT_TEXT}-->
<h1 id="top" class='headline main' data-section="intro">Q2 Report &amp; Analysis</h1>
<p title='He said "hello" &amp; left'>Revenue grew 5% &lt; forecast, but margin&nbsp;held. Costs &amp; risks below.</p>
<img src="assets/chart-q2.png" alt='Revenue "trend" chart' width="640">
<pre>${PRE_TEXT}</pre>
<table border="1">
<thead><tr><th>Metric</th><th>Q1</th><th>Q2</th></tr></thead>
<tbody>
<tr><td>Revenue &amp; fees</td><td>$1,200</td><td>$1,260</td></tr>
<tr><td>Margin</td><td>41%</td><td>43%</td></tr>
</tbody>
</table>
<template id="row-template"><tr class="row"><td>placeholder</td></tr></template>
<script>${SCRIPT_TEXT}</script>
</body>
</html>
`;
