/**
 * Editor visuals injected into the document view via webContents.insertCSS —
 * that path bypasses the page's CSP, unlike a preload-created <style>.
 *
 * Values come from the APPROVED mockup (design/mockups/redra-concept.html):
 * a quiet BLUE wash + hairline marks the block under the pointer; the element
 * actively being edited reads in the red accent (#D9482B / #FF6B4A dark) — a
 * faint red wash + hairline plus the native red caret-color.
 *
 * The handle pill / ghost / drop indicator live inside the overlay's closed
 * shadow root (src/preload/editor/overlay.ts) and carry their own styles —
 * page CSS cannot reach them, and this sheet cannot either.
 *
 * Everything is wrapped in @media screen: printToPDF (printBackground: true)
 * renders print styles, and the hover wash/hairline must never end up in an
 * exported PDF.
 */
export const EDITOR_CSS = `
@media screen {
.redra-hover {
  background: rgba(44, 123, 229, 0.06);
  outline: 1.5px solid rgba(44, 123, 229, 0.55);
  outline-offset: 0;
  border-radius: 9px;
}
.redra-editing-el {
  outline: 1.5px solid rgba(217, 72, 43, 0.55);
  outline-offset: 2px;
  border-radius: 3px;
  background: rgba(217, 72, 43, 0.05);
  caret-color: #d9482b;
}
html.redra-dragging,
html.redra-dragging * {
  cursor: grabbing !important;
}
@media (prefers-color-scheme: dark) {
  .redra-hover {
    background: rgba(90, 160, 255, 0.1);
    outline-color: rgba(90, 160, 255, 0.6);
  }
  .redra-editing-el {
    outline-color: rgba(255, 107, 74, 0.55);
    background: rgba(255, 107, 74, 0.07);
    caret-color: #ff6b4a;
  }
}
}
`;
