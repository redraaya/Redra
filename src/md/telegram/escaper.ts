/**
 * MarkdownV2 escaping (core correctness of "Copy for Telegram", blueprint
 * from MarkMello's MarkdownV2Escaper). Telegram's classic parser is strict:
 * outside an entity these 18 characters are special and MUST be backslash-
 * escaped, or the message is rejected / mis-rendered.
 */
const V2_SPECIAL = new Set('_*[]()~`>#+-=|{}.!'.split(''));

/** Escape a literal text run for MarkdownV2 body context. */
export function escapeV2(text: string): string {
  let out = '';
  for (const ch of text) out += V2_SPECIAL.has(ch) ? `\\${ch}` : ch;
  return out;
}

/** Inside `code`/```pre``` only ` and \ are special. */
export function escapeV2Code(text: string): string {
  return text.replace(/([`\\])/g, '\\$1');
}

/** Inside a link/emoji destination only ) and \ are special. */
export function escapeV2Url(url: string): string {
  return url.replace(/([)\\])/g, '\\$1');
}
