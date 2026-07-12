/**
 * Dialect sniffer (user decision #2): an opened file's OWN notation wins.
 *
 * The writer consults this profile so NEW formatting blends into the file's
 * existing style — a file that writes __bold__ keeps getting __bold__, a
 * file with `*` bullets keeps `*`. Every signal is a per-entity majority
 * vote read from the pristine mdast + raw source spans; entities the file
 * does not use fall back to the Telegram-Rich defaults (what File → New
 * uses from the start). When in doubt the sniffer stays with defaults —
 * conservative beats clever (plan risk R4).
 */
import type { MdDoc } from './md-types.js';

export interface MdFlavor {
  bold: '**' | '__';
  italic: '*' | '_';
  bullet: '-' | '*' | '+';
  strike: '~~' | '~';
  fence: '```' | '~~~';
  hr: string; // '---' | '***' | '___'
  /** ||…|| (Telegram Rich / Discord) or the <tg-spoiler> tag form. */
  spoiler: 'pipes' | 'tag';
  underline: 'u' | 'ins';
}

/** Telegram-Rich conventions — the New-file defaults. */
export const RICH_DEFAULTS: MdFlavor = {
  bold: '**',
  italic: '*',
  bullet: '-',
  strike: '~~',
  fence: '```',
  hr: '---',
  spoiler: 'pipes',
  underline: 'u',
};

function majority<T extends string>(votes: Map<T, number>, fallback: T): T {
  let best = fallback;
  let bestCount = 0;
  for (const [key, count] of votes) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : fallback;
}

function bump<T extends string>(votes: Map<T, number>, key: T): void {
  votes.set(key, (votes.get(key) ?? 0) + 1);
}

export function sniffFlavor(doc: MdDoc): MdFlavor {
  const src = doc.source;
  const bold = new Map<'**' | '__', number>();
  const italic = new Map<'*' | '_', number>();
  const bullet = new Map<'-' | '*' | '+', number>();
  const strike = new Map<'~~' | '~', number>();
  const fence = new Map<'```' | '~~~', number>();
  const hr = new Map<string, number>();
  const spoiler = new Map<'pipes' | 'tag', number>();
  const underline = new Map<'u' | 'ins', number>();

  const at = (node: { position?: { start: { offset?: number } } }): number | undefined =>
    node.position?.start.offset;

  const visit = (node: {
    type: string;
    ordered?: boolean;
    children?: unknown[];
    value?: string;
    position?: { start: { offset?: number } };
  }): void => {
    const start = at(node);
    switch (node.type) {
      case 'strong': {
        if (start !== undefined) bump(bold, src.slice(start, start + 2) === '__' ? '__' : '**');
        break;
      }
      case 'emphasis': {
        if (start !== undefined) bump(italic, src[start] === '_' ? '_' : '*');
        break;
      }
      case 'delete': {
        if (start !== undefined) bump(strike, src.slice(start, start + 2) === '~~' ? '~~' : '~');
        break;
      }
      case 'listItem': {
        if (start !== undefined) {
          const ch = src[start];
          if (ch === '-' || ch === '*' || ch === '+') bump(bullet, ch);
        }
        break;
      }
      case 'code': {
        if (start !== undefined) {
          const ch = src[start];
          if (ch === '`') bump(fence, '```');
          else if (ch === '~') bump(fence, '~~~');
          // indented code votes for nothing
        }
        break;
      }
      case 'thematicBreak': {
        if (start !== undefined) {
          const ch = src[start];
          if (ch === '-') bump(hr, '---');
          else if (ch === '*') bump(hr, '***');
          else if (ch === '_') bump(hr, '___');
        }
        break;
      }
      case 'tgSpoiler':
        bump(spoiler, 'pipes');
        break;
      case 'html': {
        const v = (node.value ?? '').toLowerCase();
        if (v.includes('<tg-spoiler')) bump(spoiler, 'tag');
        if (v.includes('<u>') || v.includes('<u ')) bump(underline, 'u');
        if (v.includes('<ins>') || v.includes('<ins ')) bump(underline, 'ins');
        break;
      }
    }
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(doc.tree as unknown as Parameters<typeof visit>[0]);

  return {
    bold: majority(bold, RICH_DEFAULTS.bold),
    italic: majority(italic, RICH_DEFAULTS.italic),
    bullet: majority(bullet, RICH_DEFAULTS.bullet),
    strike: majority(strike, RICH_DEFAULTS.strike),
    fence: majority(fence, RICH_DEFAULTS.fence),
    hr: majority(hr, RICH_DEFAULTS.hr),
    spoiler: majority(spoiler, RICH_DEFAULTS.spoiler),
    underline: majority(underline, RICH_DEFAULTS.underline),
  };
}
