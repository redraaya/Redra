/**
 * Editor visuals injected into the document view via webContents.insertCSS —
 * that path bypasses the page's CSP, unlike a preload-created <style>.
 *
 * Values come from the APPROVED mockup (design/mockups/redra-concept.html):
 * quiet wash + hairline only, the red accent (#D9482B / #FF6B4A dark) exists
 * solely as the text caret. No red frames anywhere.
 *
 * The handle pill / ghost / drop indicator live inside the overlay's closed
 * shadow root (src/preload/editor/overlay.ts) and carry their own styles —
 * page CSS cannot reach them, and this sheet cannot either.
 */
export const EDITOR_CSS = `
.redra-hover {
  background: rgba(28, 27, 25, 0.035);
  outline: 1px solid rgba(28, 27, 25, 0.13);
  outline-offset: 0;
  border-radius: 9px;
}
.redra-editing-el {
  outline: 1px solid rgba(28, 27, 25, 0.13);
  outline-offset: 5px;
  border-radius: 2px;
  caret-color: #d9482b;
}
html.redra-dragging,
html.redra-dragging * {
  cursor: grabbing !important;
}
@media (prefers-color-scheme: dark) {
  .redra-hover {
    background: rgba(236, 234, 230, 0.045);
    outline-color: rgba(236, 234, 230, 0.18);
  }
  .redra-editing-el {
    outline-color: rgba(236, 234, 230, 0.18);
    caret-color: #ff6b4a;
  }
}
`;
