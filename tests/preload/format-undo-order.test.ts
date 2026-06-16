// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { computeInlineToggle } from '../../src/preload/editor/format.js';

/**
 * v0.3.5 — the `code` (`<>`) toggle must be undoable with ⌘Z in correct
 * chronological order relative to typing / bold / italic / link in the SAME
 * edit session.
 *
 * Root cause (fixed): the code toggle used manual Range surgery
 * (extractContents/insertNode/unwrap), which Chromium does NOT record on the
 * contenteditable native undo stack — so ⌘Z (which the controller routes to
 * document.execCommand('undo') during a session) skipped it. bold/italic/link
 * go through execCommand and ARE on that stack. The fix computes the toggle
 * with computeInlineToggle() and applies it via ONE
 * document.execCommand('insertHTML', …), so it joins the same single native
 * timeline as everything else and the ordering is automatic.
 *
 * WHAT THIS FILE ASSERTS vs WHAT IT CANNOT:
 *   jsdom has NO document.execCommand at all (verified: it is `undefined`), so
 *   it cannot drive Chromium's real native undo stack. We therefore MODEL that
 *   stack the way Chromium actually behaves for these ops — each op pushes an
 *   innerHTML snapshot, undo pops to the previous snapshot — and drive the
 *   code toggle through the EXACT transform the controller uses
 *   (computeInlineToggle → select plan range → replace with plan.html). This
 *   proves: (1) the toggle reduces to a single snapshot-producing mutation
 *   that sits in chronological order with bold/typing, and (2) three undos
 *   revert code → bold → typing, in that order.
 *
 *   What still needs MANUAL verification in the real app (documented in the
 *   report): that Electron's Chromium genuinely records execCommand('insertHTML')
 *   on the contenteditable undo stack and leaves the caret/selection sane. That
 *   is an engine behaviour jsdom cannot exercise.
 */

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<p id="host" data-redra-id="rA">seed </p>';
  host = document.getElementById('host')!;
});

/**
 * A faithful stand-in for the contenteditable native undo stack: every op
 * snapshots host.innerHTML; undo restores the prior snapshot, redo re-applies.
 * This is exactly the observable contract of Chromium's stack for the ops in
 * play (typing, execCommand('bold'), execCommand('insertHTML')).
 */
class NativeStack {
  private readonly past: string[] = [];
  private readonly future: string[] = [];
  constructor(private readonly el: HTMLElement) {}
  /** Snapshot BEFORE mutating, run the mutation; clears the redo branch. */
  do(mutate: () => void): void {
    this.past.push(this.el.innerHTML);
    this.future.length = 0;
    mutate();
  }
  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.el.innerHTML);
    this.el.innerHTML = prev;
    return true;
  }
  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.el.innerHTML);
    this.el.innerHTML = next;
    return true;
  }
}

/** Select all of host's contents (a deterministic, full-paragraph selection). */
function selectAll(): Range {
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.selectNodeContents(host);
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}

/** Replace the current selection's range with html — models insertHTML. */
function insertHtmlOverRange(range: Range, html: string): void {
  range.deleteContents();
  range.insertNode(range.createContextualFragment(html));
}

/** Apply a code toggle the way the controller does on the native path. */
function codeToggle(stack: NativeStack): void {
  const sel = window.getSelection()!;
  const range = sel.getRangeAt(0);
  const plan = computeInlineToggle(range, 'code', host);
  stack.do(() => {
    sel.removeAllRanges();
    sel.addRange(plan.selectRange);
    insertHtmlOverRange(plan.selectRange, plan.html);
  });
}

describe('code toggle is undoable via the native stack (modeled)', () => {
  it('a single code toggle then one undo returns to the pre-toggle innerHTML', () => {
    const stack = new NativeStack(host);
    host.innerHTML = 'hello world';
    selectAll();
    const before = host.innerHTML;

    codeToggle(stack);
    expect(host.innerHTML).toBe('<code>hello world</code>'); // wrapped
    expect(host.querySelector('code')).not.toBeNull();

    expect(stack.undo()).toBe(true);
    expect(host.innerHTML).toBe(before); // the <code> is gone again
  });

  it('mixed order — type, bold, code — three undos revert code → bold → typing', () => {
    const stack = new NativeStack(host);
    const sel = window.getSelection()!;

    // 1) "type": append text (one native step).
    const snapStart = host.innerHTML; // 'seed '
    stack.do(() => {
      host.append(document.createTextNode('typed'));
    });
    const afterType = host.innerHTML; // 'seed typed'
    expect(afterType).toBe('seed typed');

    // 2) "bold": wrap the whole paragraph in <b> (models execCommand('bold')).
    stack.do(() => {
      const r = document.createRange();
      r.selectNodeContents(host);
      const contents = r.extractContents();
      const b = document.createElement('b');
      b.appendChild(contents);
      r.insertNode(b);
    });
    const afterBold = host.innerHTML; // '<b>seed typed</b>'
    expect(afterBold).toBe('<b>seed typed</b>');

    // 3) "code": toggle code over the whole selection via the native path.
    const r = document.createRange();
    r.selectNodeContents(host);
    sel.removeAllRanges();
    sel.addRange(r);
    codeToggle(stack);
    const afterCode = host.innerHTML;
    expect(host.querySelector('code')).not.toBeNull();
    expect(host.textContent).toBe('seed typed'); // text preserved
    expect(afterCode).not.toBe(afterBold);

    // Three undos peel back in strict reverse chronological order.
    expect(stack.undo()).toBe(true);
    expect(host.innerHTML).toBe(afterBold); // code undone first
    expect(stack.undo()).toBe(true);
    expect(host.innerHTML).toBe(afterType); // then bold
    expect(stack.undo()).toBe(true);
    expect(host.innerHTML).toBe(snapStart); // then the typing
  });

  it('redo re-applies the code toggle after an undo (native stack supports it)', () => {
    const stack = new NativeStack(host);
    host.innerHTML = 'redo me';
    selectAll();

    codeToggle(stack);
    const wrapped = host.innerHTML;
    expect(wrapped).toBe('<code>redo me</code>');

    expect(stack.undo()).toBe(true);
    expect(host.querySelector('code')).toBeNull();
    expect(stack.redo()).toBe(true);
    expect(host.innerHTML).toBe(wrapped); // code toggle restored
  });

  it('unwrap toggle is one native step too — code on, code off, one undo restores the <code>', () => {
    const stack = new NativeStack(host);
    host.innerHTML = '<code>already</code>';
    // Select INSIDE the code's text (as a real caret/selection does) so the
    // toggle's ancestor check sees the <code> and takes the unwrap branch.
    const codeText = host.querySelector('code')!.firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(codeText, 0);
    r.setEnd(codeText, (codeText as Text).length);
    sel.removeAllRanges();
    sel.addRange(r);
    const wrapped = host.innerHTML;

    codeToggle(stack); // toggle OFF (unwrap the whole element)
    expect(host.querySelector('code')).toBeNull();
    expect(host.textContent).toBe('already');

    expect(stack.undo()).toBe(true);
    expect(host.innerHTML).toBe(wrapped); // the <code> is back, one step
  });
});
