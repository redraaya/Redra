// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashMenu } from '../../src/preload/editor/slash-menu.js';
import { makeT } from '../../src/shared/i18n.js';

const t = makeT('ru');
const RECT = { left: 100, bottom: 200, top: 180 };

describe('SlashMenu', () => {
  let parent: HTMLElement;
  let onPick: ReturnType<typeof vi.fn>;
  let menu: SlashMenu;

  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
    parent = document.getElementById('host')!;
    onPick = vi.fn();
    menu = new SlashMenu(document, parent, t, onPick);
  });

  const rows = () => Array.from(parent.querySelectorAll('.slashmenu .row .label')).map((n) => n.textContent);
  const key = (k: string) => menu.handleKey(new KeyboardEvent('keydown', { key: k }));

  it('opens with every block type and applies the active one on Enter', () => {
    menu.open(RECT);
    expect(menu.visible).toBe(true);
    expect(rows()).toContain(t('panel.task'));
    expect(rows()!.length).toBe(10);
    key('Enter');
    expect(onPick).toHaveBeenCalledWith('h1'); // first item
    expect(menu.visible).toBe(false);
  });

  it('arrows move the active row; Enter applies it', () => {
    menu.open(RECT);
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(onPick).toHaveBeenCalledWith('h3');
  });

  it('typing filters by the localized name', () => {
    menu.open(RECT);
    key('ч'); // "чек-лист"
    key('е');
    key('к');
    expect(rows()).toEqual([t('panel.task')]);
    key('Enter');
    expect(onPick).toHaveBeenCalledWith('task');
  });

  it('Escape closes without applying; Backspace past the query closes too', () => {
    menu.open(RECT);
    expect(key('Escape')).toBe(true);
    expect(menu.visible).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    menu.open(RECT);
    expect(key('Backspace')).toBe(true); // empty query → close (slash erased)
    expect(menu.visible).toBe(false);
  });

  it('an unrelated key (space) closes and is NOT consumed', () => {
    menu.open(RECT);
    expect(key(' ')).toBe(false);
    expect(menu.visible).toBe(false);
  });

  it('clicking a row applies its kind', () => {
    menu.open(RECT);
    const taskRow = Array.from(parent.querySelectorAll('.slashmenu .row')).find((r) =>
      r.textContent!.includes(t('panel.task')),
    )!;
    taskRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).toHaveBeenCalledWith('task');
    expect(menu.visible).toBe(false);
  });
});
