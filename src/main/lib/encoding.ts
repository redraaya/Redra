/**
 * Encoding detection + decoding for opened HTML files.
 * BOM first, then a <meta charset> sniff in the first 1024 bytes, else utf-8.
 * Pure module (TextDecoder is a global in Node ≥ 18 and in Electron's main process).
 */

export interface EncodingDetection {
  /** Encoding label to pass to TextDecoder. */
  encoding: string;
  /** Number of BOM bytes to skip before decoding. */
  bomLength: number;
}

export interface DecodedHtml {
  text: string;
  /** Canonical encoding actually used for decoding (TextDecoder name). */
  encoding: string;
  hadBom: boolean;
}

const SNIFF_LIMIT = 1024;

/** Find a charset declaration (`<meta charset=...>` or http-equiv content) in the head bytes. */
export function sniffMetaCharset(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, SNIFF_LIMIT);
  // Latin-1 view is enough: charset names are ASCII.
  let ascii = '';
  for (let i = 0; i < head.length; i++) ascii += String.fromCharCode(head[i]!);
  // Anchor to a <meta ...> tag so accept-charset on forms, comments and
  // inline script text within the sniff window are not mistaken for a
  // declaration. Covers both <meta charset=...> and the http-equiv form
  // (charset=... inside the content attribute).
  const m = /<meta[^>]*charset\s*=\s*["']?\s*([A-Za-z0-9][A-Za-z0-9._:-]*)/i.exec(ascii);
  return m ? m[1]!.toLowerCase() : null;
}

export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', bomLength: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', bomLength: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', bomLength: 2 };
  }
  const meta = sniffMetaCharset(bytes);
  return { encoding: meta ?? 'utf-8', bomLength: 0 };
}

/** Decode HTML bytes respecting BOM and <meta charset>; falls back to utf-8 on unknown labels. */
export function decodeHtml(bytes: Uint8Array): DecodedHtml {
  const { encoding, bomLength } = detectEncoding(bytes);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const text = decoder.decode(bytes.subarray(bomLength));
  return { text, encoding: decoder.encoding, hadBom: bomLength > 0 };
}
