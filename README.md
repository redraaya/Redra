# Redra

**Open HTML. Click. Write.**

Redra is a visual HTML file editor for macOS. Open any HTML file — it renders
just like Chrome. Click into the text and write. Drag blocks by their handle,
delete what you don't need, hit ⌘S — and the same file is saved back to disk.
Or export it to PDF.

![A document in Redra](docs/assets/redra-doc.png)

![Redra features](docs/assets/features.png)

## How it works

Your edits live on top of an untouched source: when a file is opened, parse5
parses it into a reference tree, and every action you take is recorded in an
operation journal. The live DOM in the window is never serialized — on save,
the journal is applied to the reference tree, so the only thing that reaches
the file is what you actually changed. Saving with no edits writes the
original back byte for byte: no phantom git diffs, no "tidied up" markup.

![Redra start screen](docs/assets/redra-start.png)

## Install

1. Download `Redra-<version>-arm64.dmg` from the
   [Releases](https://github.com/redraaya/Redra/releases) page (Apple Silicon
   only).
2. Open the DMG and drag **Redra** into **Applications**.
3. **First launch**: the app is not signed with an Apple certificate, so
   Gatekeeper blocks it with a message that it could not be opened. This is
   expected — do the following:
   1. Try to open Redra (double-click). A warning appears — click
      **Done**/**OK**.
   2. Open **System Settings → Privacy & Security** and scroll down: an
      **"Open Anyway"** button appears next to the message about Redra (the
      button only shows up after the first launch attempt).
   3. Click it and confirm (you'll need your password or Touch ID).

   You only do this once — afterwards Redra opens normally.
   Terminal alternative:

   ```sh
   xattr -cr /Applications/Redra.app
   ```

Once installed, Redra shows up in Finder's "Open With…" menu for `.html` and
`.htm` files.

## Hotkeys

| Shortcut | Action |
| --- | --- |
| ⌘O | Open a file |
| ⌘S | Save |
| ⇧⌘S | Save As… |
| ⌘E | Preview mode (toggles editing on/off) |
| ⇧⌘E | Export to PDF… |
| ⌘Z | Undo |
| ⇧⌘Z | Redo |
| Esc | Revert the element being edited (back to how it was) or cancel a drag |
| ⌘-click a link | Open the link in your browser |

## Known v1 limitations

- **iframes**: the editing layer does not reach into iframe content — a page
  inside an iframe lives its own life and cannot be edited.
- **`transform`/`filter` on `<html>`**: these styles on the root element
  create a new containing block for `position: fixed`, so the block handle
  pill may be positioned with an offset on such pages.
- One window — one document; relative links to sibling `.html` files are
  deliberately dead until multi-document support lands.

## Build from source

```sh
npm install
npm run dev        # run in development mode
npm test           # engine and shell tests
npm run smoke      # build + smoke run of a real window
npm run dist       # DMG for Apple Silicon in dist/
```

## Updates

Redra quietly checks GitHub releases once per launch. When a newer version is
out, a small pill appears in the titlebar — click it to open the download
page, or dismiss it and it won't come back for that version.

## License

[MIT](LICENSE)
