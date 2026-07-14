/**
 * "Copy for Telegram" — the clipboard HTML flavor.
 *
 * Telegram's 2026 composer (headings, lists, checklists, quotes, code,
 * tables) ingests a rich paste the way every editor does: STANDARD document
 * HTML, the same thing a browser or Google Docs puts on the clipboard. So
 * this is simply Redra's own render of the document, scrubbed of everything
 * internal:
 *   - data-redra-* stamps and view classes never leave the app;
 *   - the task checkbox <input> becomes a text glyph (form controls don't
 *     survive clipboard HTML) — "☑ " / "☐ ";
 *   - <tg-spoiler> (not a standard tag) unwraps to its text;
 *   - island wrappers unwrap to their content.
 *
 * The plain-text flavor next to it is the GFM source itself — never an
 * escaped bot dialect: a text-only paste must read as clean Markdown.
 */
import { parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;

function attr(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

type P5Child = DefaultTreeAdapterMap['childNode'];

function textNode(value: string, parent: P5Parent): P5Child {
  return { nodeName: '#text', value, parentNode: parent } as unknown as P5Child;
}

function scrub(parent: P5Parent): void {
  const children = parent.childNodes ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]!;
    if (!isElement(child)) continue;

    // Task checkbox → a text glyph; every other input was never rendered.
    if (child.tagName === 'input') {
      const checked = attr(child, 'checked') !== undefined;
      children.splice(i, 1, textNode(checked ? '☑' : '☐', parent)); // the render's own space follows
      continue;
    }

    // Non-standard / internal wrappers unwrap to their content.
    if (child.tagName === 'tg-spoiler' || attr(child, 'data-redra-island') !== undefined) {
      const inner = child.childNodes ?? [];
      for (const c of inner) (c as { parentNode: P5Parent }).parentNode = parent;
      children.splice(i, 1, ...inner);
      // The spliced-in children still need their own scrub pass.
      scrub(parent);
      return;
    }

    child.attrs = child.attrs.filter(
      (a) => !a.name.startsWith('data-redra-') && a.name !== 'class' && a.name !== 'contenteditable' && a.name !== 'tabindex',
    );
    scrub(child);
  }
}

/** Standard clipboard HTML for the document body render. */
export function toClipboardHtml(bodyHtml: string): string {
  const fragment = parseFragment(bodyHtml);
  scrub(fragment);
  return serialize(fragment);
}
