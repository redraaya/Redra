# Redra — a desktop visual editor for HTML files

## Context

AI tools generate results as HTML files at scale — reports, analytics, presentations. Today the only way to edit such a file is through code. Market research (June 2026) showed the niche is empty: the only living analog, Pinegrow, is a paid pro tool for web developers; BlueGriffon/KompoZer/Amaya are dead; Word/LibreOffice destroy the markup on save; BlockNote/Tiptap/GrapesJS are libraries, not applications.

**We build our own.** The scenario: open an HTML file → see it exactly as in Chrome → **click into the text and just write** → drag/delete a block → save the same file (layout intact) → export to PDF if you want. Aesthetics modeled on [MarkMello](https://github.com/dartdavros/MarkMello): minimal interface around the content.

**The two top product priorities: design and speed.** Targets: cold start < 1.5 s, file open at Chrome speed, click/typing response < 16 ms (no jank), save < 100 ms. The shell uses no heavy frameworks (vanilla TS + CSS).

Name: **Redra** (approved by the user).

## Decisions made with the user

- **No mode switching**: open the file — and you can edit right away ("click and write"). The "Preview" mode (full page interactivity, as in Chrome) is an optional toggle for special cases, not the default.
- **Export v1**: save HTML (same file / Save As) + export to PDF.
- **Distribution**: open source on GitHub, releases via GitHub Actions. **macOS Apple Silicon (arm64) only at first** — for speed of shipping. Windows and Intel Mac follow (the architecture is cross-platform from day one; these are just build targets).
- **Save semantics**: visual integrity. Deleted blocks at the top — the rest "pulls up"; added text on slide 3 — neighboring slides are unharmed. Achieved by **never touching CSS or structure — only the editable content**.
- **The user controls the visuals**: every stage that affects appearance (shell, icon, start screen, block handles) starts with mockups for approval. No design gets coded without approval.

## Technology: Electron (not Avalonia, as in MarkMello)

MarkMello is written in C#/Avalonia and renders Markdown with native controls — that works for Markdown, the format is primitive. Avalonia cannot render arbitrary HTML+CSS+JS "exactly as in Chrome" — we would have to embed Chromium anyway, and the editing logic would still live in JS. Hence Electron: real Chromium inside, 1:1 rendering with Chrome. The cost is ~150–200 MB on disk (like Notion/Slack); it does not affect working speed — the speed budgets above are mandatory.

Stack: **Electron + TypeScript + electron-vite, parse5 (source parsing), electron-builder + GitHub Actions, vitest (engine tests)**.

## Architecture: "edits over a pristine source"

The key corner case: files contain their own scripts (charts, interactivity) that mutate the DOM on the fly. Serializing the live DOM is not an option — garbage would end up in the file. Therefore:

1. **Load.** The file is parsed with parse5 without executing scripts → the "reference tree". Every element gets a stable id (`data-redra-id`); the stamped copy is served to the window via our own `redra://` protocol (which also serves images and resources by relative paths from the file's folder).
2. **Display.** The page lives as in Chrome: scripts run, charts draw. Elements created by scripts on the fly have no id → not editable (correctly so: they are not in the source).
3. **Editing = a journal of operations**: `editText(id, content)`, `deleteBlock(id)`, `moveBlock(id, position)`. The journal gives undo/redo for free.
4. **Save.** The operations are applied to the reference tree (without the stamping); the result is serialized and written atomically. Everything untouched — styles, scripts, attributes, comments — is carried over as is.

The engine (`parse → tree → operations → serialize`) is pure TypeScript with no Electron dependencies, fully covered by unit tests.

### Interaction (live editing by default)

The editor layer is injected via preload into an isolated world — the file's CSP and scripts cannot interfere with it, and it leaves no litter in the page.

- **Click into text → caret immediately**, and you write. The nearest text element becomes precisely contenteditable; the operation is committed on blur/Esc. Styles are inherited from the page automatically.
- **Links**: click = edit the link text; **Cmd+click** = open in the browser (hint on hover).
- **Page interactivity** (buttons, handlers): suppressed in live editing so clicks have no side effects. The "Preview" toggle brings back full Chrome-like interactivity.
- **Blocks**: on hover — outline + a ⋮⋮ handle (as in Notion) + delete. Dragging reorders among siblings within the parent (v1). After a delete the document "pulls up" via the page's own CSS.
- **Undo/redo**: Cmd+Z / Cmd+Shift+Z.
- Hotkeys: Cmd+O, Cmd+S, Cmd+Shift+S (Save As), Cmd+E ("Preview" toggle).

### Shell

Start screen (drag-and-drop + recent files), a thin toolbar (open, preview toggle, save, PDF), light/dark shell theme (the content is colored by the file itself), unsaved-changes indicator, warning on close. Design — only from approved mockups.

### Saving and export

Atomic write (tmp + rename); a backup copy `name.html.bak` on first save (a setting, on by default); mtime check for external changes; PDF via `webContents.printToPDF`.

## Corner cases

| Case | Solution |
|---|---|
| Page scripts redraw the DOM | We save the reference tree + operations; the live DOM is never serialized |
| The file is rendered entirely by a script (React-like) | Almost nothing to edit — a "content is generated by a script" notice |
| CSP in the file blocks injection | Preload + isolated world + insertCSS bypass CSP |
| Clicking a link/button triggers side effects | Live editing suppresses page handlers; Cmd+click and "Preview" mode are there for interactivity |
| Presentation with fixed slides | We never touch CSS → editing text does not affect neighboring slides |
| Relative resource paths | The `redra://` protocol serves them from the file's folder |
| contenteditable produces dirty HTML | Normalization on commit (whitelist of inline tags) |
| Encodings, entities, `<pre>` whitespace | parse5 — the same parsing algorithm as in browsers |
| File changed externally while working | mtime check + warning |

## Future-proofing — no rewrites

The operation-journal architecture extends by adding operation types, redoing nothing:

- moving a block to another container → `moveBlock(id, newParentId, index)` — same core;
- duplicating a block → `cloneBlock(id)`;
- replacing images → `setAttr(id, 'src', …)` + copying the file alongside;
- inline formatting (bold/italic/link) → a toolbar over the selection, committed via the same `editText`;
- in-document search → pure UI, the engine is untouched;
- Markdown export → serializing the reference tree through turndown;
- Windows/Intel Mac → electron-builder build targets, shared code;
- signing/notarization/auto-updates → build configuration + an Apple account, no code changes.

Deliberately out of v1, but blocked by nothing.

## Development process: multi-agent, with cross-review

Each stage: an **implementer agent** works from the stage spec → a **reviewer agent** (superpowers:code-reviewer) checks the result against the plan and standards → tests must pass → only then the next stage. Context is never lost: the design doc and the implementation plan live in the repository (`docs/plans/`), commits per stage; every agent receives the stage spec + the design doc, not a retelling from memory. UI stages additionally go through visual verification with screenshots and user approval.

## Stages

**Stage 0 — design concept (with the user).** Shell mockups (start screen, document window, block handles, toolbar) as HTML prototypes + 2–3 icon concepts. Iterate until approved. The application name is finalized here too.

**Stage 1 — engine (pure TS + vitest).** parse5 parsing, id stamping, operation journal, applying to the reference tree, serialization, undo/redo. Tests: round-trip with no edits; every operation; mixed scenarios; `<pre>`, comments, inline scripts.

**Stage 2 — Electron skeleton.** Window, `redra://` protocol, file open (dialog + drag-and-drop + .html association), loading the stamped copy, navigation interception, save/Save As, recent files. Speed-budget measurements.

**Stage 3 — live editing layer.** Preload injection, click-into-text, contenteditable normalization, block highlight and handles (per the approved design), delete, drag-reorder, undo/redo, "Preview" toggle, operation bridge.

**Stage 4 — shell and polish.** Start screen and toolbar from the Stage 0 mockups, themes, change indicator, .bak, mtime, PDF export, icon.

**Stage 5 — distribution.** electron-builder: arm64 DMG; GitHub Actions release on tag; README with screenshots; license (MIT or GPL-3.0 — decide at publication).

## Access and preparation from the user

1. **GitHub** (decided: set up at the start): I install the GitHub CLI (`brew install gh`), the user logs in once via `gh auth login` (browser, a couple of clicks). From then on I handle the repository, pushes and releases. Node.js v25 and npm are already installed — nothing else is needed for development.
2. **Not needed now**: an Apple Developer account ($99/year) is required only for signing/notarization for public distribution — not for personal use and GitHub releases.

## Verification

- Engine unit tests (vitest) — the primary control of save correctness.
- Cross-review by agents at every stage.
- Manual runs on real files: a one-page report with charts, a multi-slide HTML presentation, a document with `<style>`. Criteria: rendering matches Chrome; editing one slide does not break the others; deleting a block "pulls up" the document; the saved file is indistinguishable in Chrome outside the edits; the PDF is correct.
- Budget measurements: start < 1.5 s, response < 16 ms, save < 100 ms.
- Running the packaged DMG on macOS arm64.

## Stage 0 decisions (design concept)

- **Icon: concept B** — a red tile (#D9482B), a white lowercase "r" + a blinking white caret.
- **Block selection — quiet, modeled on MarkMello**: on hover — a soft wash (ink 3.5%) + a hairline (ink 13%), the ⋮⋮ handle in neutral gray. The element being edited — a hairline with a 5px offset. The red accent (#D9482B / #FF6B4A in dark) — ONLY the caret and the unsaved-changes dot. No red frames anywhere in the editing UI.
- Shell palette: warm paper #F7F6F3 / dark #1B1A18; MarkMello cover as the reference: dark screen, warm accent, quiet buttons.
- Mockups: design/mockups/redra-concept.html

## Decision from the Stage 1 review

- **Saving with no edits = byte-for-byte original.** If the operation journal is empty, the original bytes are written to the file (no parse5 normalization). Documents under git get no phantom diffs. serializeSource(doc) without operations returns the original; with operations — the serialization of the applied tree.

## Known v1 limitations

- **iframe**: click suppression and the editing layer do not reach iframe content (including same-process iframes) — preload works in the main frame; the page inside an iframe lives its own life and is not editable.
- **transform/filter on `<html>`**: CSS `transform`/`filter` on the root element creates a new containing block for `position: fixed` — the block-handle plate may be positioned with an offset on such pages.

## Stage 5 decisions (distribution)

- **License: MIT** (copyright 2026 redraaya) — chosen from the MIT/GPL-3.0 pair declared in the stage plan.
- **DMG arm64 only, unsigned** (`identity: null`): no Apple Developer account, notarization postponed. The Gatekeeper walkthrough (right-click → "Open", or `xattr -cr`) is documented in the README. The `.html`/`.htm` association is an Editor role with `LSHandlerRank: Alternate`: Redra appears in "Open With…" without taking the files away from the browser.
- **CI and releases on macos-14 (Apple Silicon)**: ci.yml — tests, typecheck and smoke on every push/PR to main (macOS runners can open a real Electron window; if smoke turns out flaky — move it into a separate job); release.yml — on a `v*` tag builds the DMG (`CSC_IDENTITY_AUTO_DISCOVERY=false`) and publishes a GitHub Release with auto-generated notes.
- **Central backups** (userData/backups instead of a .bak next to the document) — locked in during the Stage 4 field fixes, entered Stage 5 unchanged.
- **README screenshots** — a hidden `--screenshot` mode (gated like `--smoke`): light theme, throwaway userData, a composition of the shell strip and the doc view, a synthesized hover on the block handle.

## Roadmap after v0.1.2 (locked with the user on 2026-06-11)

**Cycle v0.2.0 — "working with content":**
1. Image replacement: click/drag onto an <img> → file picker; for single-file documents — base64 data: embedding by default (the document stays self-contained). The setAttr operation.
2. Version history: a list of the central backups with "go back to the version as of open".
3. Inline toolbar on text selection: bold / italic / link / code.

**Cycle v0.3.0 — "structure":**
4. Block duplication (a third button on the handle: ⋮⋮, dup, trash) — the cloneBlock operation; the copy comes from the reference tree and lands after the original. DECISION: instead of Notion-style insertion of arbitrary blocks — "duplicate and rewrite" eliminates the foreign-styles problem by construction (cards, <tr>, <li>). "Empty paragraph after a block" — hold off, watch the demand after dup ships.
5. Moving blocks between containers (moveBlock with newParent).
6. Search ⌘F.

**Stage 6 — Markdown mode** (a separate large plan): the same "edits over the source" principle for .md; rendering with OUR typography (starts with a design concept for approval); live editing with no modes; mapping operations back into Markdown syntax.

**Deliberately NOT doing:** opening PDFs (PDF is an output, not an input); creating documents from scratch and templates (competing with Notion/Word outside our niche); a Notion-style block-insert menu.

**Infrastructure, before big launches (HN/PH):** Apple Developer + signing/notarization; a Windows build as an audience doubler; a "click and write" GIF in the README.
