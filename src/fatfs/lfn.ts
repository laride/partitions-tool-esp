import { asciiEncode } from '../common/binary.js';
import { ATTR_LONG_NAME, ENTRY_SIZE, MAX_EXT_SIZE, MAX_NAME_SIZE, PAD_CHAR } from './constants.js';

const CHARS_PER_LFN_ENTRY = 13;
const LFN_LAST_ENTRY_MASK = 0x40;
const LFN_NAME1_OFFSET = 1;
const LFN_NAME1_CHARS = 5;
const LFN_NAME2_OFFSET = 14;
const LFN_NAME2_CHARS = 6;
const LFN_NAME3_OFFSET = 28;
const LFN_NAME3_CHARS = 2;

/**
 * INVALID characters for a short (8.3) filename in ESP-IDF's dialect.
 * Standard FAT allows a slightly wider set, but matching ESP-IDF keeps
 * the byte-level parity with `fatfsgen.py --long_name_support`.
 */
const INVALID_SFN_CHARS = /[.+,;=[\]]/;

/** Return the 8-bit LFN checksum of the 11-byte short name (8+3). */
export function lfnChecksum(shortName11: Uint8Array): number {
  if (shortName11.length !== 11) throw new Error('shortName11 must be 11 bytes');
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum = ((sum & 1 ? 0x80 : 0) + (sum >>> 1) + shortName11[i]!) & 0xff;
  }
  return sum;
}

/**
 * Does the given filename need an LFN chain? Mirrors ESP-IDF's logic:
 * uppercases first, splits on the last dot, and checks:
 *   - invalid short-filename characters in the stem
 *   - length constraints (8.3)
 *   - casing differs from the original (preserve user intent)
 */
export function needsLfn(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  const name = dot < 0 ? filename : filename.slice(0, dot);
  const ext = dot < 0 ? '' : filename.slice(dot + 1);
  if (INVALID_SFN_CHARS.test(name)) return true;
  if (name.length > MAX_NAME_SIZE || ext.length > MAX_EXT_SIZE) return true;
  // Any lowercase content requires LFN under ESP-IDF rules.
  if (filename !== filename.toUpperCase()) return true;
  return false;
}

export interface ShortAlias {
  /** Raw 11-byte `DIR_Name` + `DIR_Name_ext` as it will land on disk. */
  bytes11: Uint8Array;
  /** Human-readable `name + '.' + ext` (uppercased). */
  display: string;
  /** Numeric order used to generate the `~N` suffix (1-based). */
  order: number;
}

/**
 * Produce a unique short alias for {@link longName} given the 11-byte short
 * aliases that already exist in the same directory. Matches ESP-IDF's
 * `name[:6] + '~' + chr(order)` scheme when `espIdfCompat` is true.
 */
export function buildShortAlias(
  longName: string,
  takenPrefixes: Map<string, number>,
  opts: { espIdfCompat: boolean },
): ShortAlias {
  const upper = longName.toUpperCase();
  const dot = upper.lastIndexOf('.');
  const name = dot < 0 ? upper : upper.slice(0, dot);
  const ext = dot < 0 ? '' : upper.slice(dot + 1);
  // Remove chars that are invalid in SFN (dots before the last one, etc.)
  const sanitized = name.replace(/[.+,;=[\]]/g, '_');
  const prefixKey = sanitized.slice(0, 6).padEnd(6, ' ');
  const order = (takenPrefixes.get(prefixKey) ?? 0) + 1;
  takenPrefixes.set(prefixKey, order);

  const bytes11 = new Uint8Array(11).fill(PAD_CHAR);
  const shortName = sanitized.slice(0, 6);
  const shortExt = ext.slice(0, 3);
  const nameBytes = asciiEncode(shortName);
  bytes11.set(nameBytes, 0);
  // 7th byte = '~', 8th byte = order marker.
  bytes11[6] = 0x7e; // '~'
  if (opts.espIdfCompat) {
    // ESP-IDF writes the raw byte chr(order), e.g. 0x01, 0x02...
    if (order > 0xff) throw new Error('LFN collision order exceeded 255');
    bytes11[7] = order;
  } else {
    // Standard: ASCII digit for small N, otherwise hex digit.
    const marker = order.toString(10);
    if (marker.length !== 1) {
      throw new Error(
        `LFN short-alias order ${order} requires multi-char tilde handling; not implemented`,
      );
    }
    bytes11[7] = marker.charCodeAt(0);
  }
  bytes11.set(asciiEncode(shortExt), 8);
  const displayName = Array.from(bytes11.subarray(0, 8), (v) => String.fromCharCode(v))
    .join('')
    .trimEnd();
  const displayExt = Array.from(bytes11.subarray(8, 11), (v) => String.fromCharCode(v))
    .join('')
    .trimEnd();
  const display = displayExt ? `${displayName}.${displayExt}` : displayName;
  return { bytes11, display, order };
}

/**
 * Build the sequence of LFN entries for a long name, in the physical on-disk
 * order (last chunk first, ending with the entry that precedes the short
 * entry). Each entry is 32 bytes.
 */
export function buildLfnEntries(
  longName: string,
  shortName11: Uint8Array,
  opts: { espIdfCompat: boolean },
): Uint8Array[] {
  const checksum = lfnChecksum(shortName11);
  // ESP-IDF adds a single null terminator if len % 13 != 0. Other chars in
  // the tail are filled with 0xFFFF by `split_name_to_lfn_entry_blocks`.
  const padded = longName.length % CHARS_PER_LFN_ENTRY === 0 ? longName : longName + '\0';
  const entriesCount = Math.ceil(padded.length / CHARS_PER_LFN_ENTRY);
  const out: Uint8Array[] = [];
  // Physical order = reverse logical order.
  for (let order = entriesCount; order >= 1; order--) {
    const chunkStart = (order - 1) * CHARS_PER_LFN_ENTRY;
    const chunk = padded.slice(chunkStart, chunkStart + CHARS_PER_LFN_ENTRY);
    const entry = new Uint8Array(ENTRY_SIZE).fill(0xff);
    const isLast = order === entriesCount;
    entry[0] = (order & 0x3f) | (isLast ? LFN_LAST_ENTRY_MASK : 0);
    entry[11] = ATTR_LONG_NAME;
    entry[12] = 0;
    entry[13] = checksum;
    entry[26] = 0;
    entry[27] = 0;
    writeLfnBlock(entry, LFN_NAME1_OFFSET, chunk.slice(0, LFN_NAME1_CHARS), LFN_NAME1_CHARS, opts);
    writeLfnBlock(
      entry,
      LFN_NAME2_OFFSET,
      chunk.slice(LFN_NAME1_CHARS, LFN_NAME1_CHARS + LFN_NAME2_CHARS),
      LFN_NAME2_CHARS,
      opts,
    );
    writeLfnBlock(
      entry,
      LFN_NAME3_OFFSET,
      chunk.slice(LFN_NAME1_CHARS + LFN_NAME2_CHARS),
      LFN_NAME3_CHARS,
      opts,
    );
    out.push(entry);
  }
  return out;
}

function writeLfnBlock(
  entry: Uint8Array,
  offset: number,
  content: string,
  chars: number,
  opts: { espIdfCompat: boolean },
): void {
  for (let i = 0; i < chars; i++) {
    if (i < content.length) {
      let code = content.charCodeAt(i);
      // ESP-IDF lowercases LFN bytes by applying .lower() on the raw UTF-16
      // bytes; for ASCII this just folds 'A'..'Z' to 'a'..'z'.
      if (opts.espIdfCompat && code >= 0x41 && code <= 0x5a) code += 0x20;
      entry[offset + i * 2] = code & 0xff;
      entry[offset + i * 2 + 1] = (code >>> 8) & 0xff;
    } else {
      // already 0xff from the initial fill
    }
  }
}

/**
 * Extract the 13 chars of an LFN entry (may include a trailing null or be
 * padded with 0xFFFF at the tail). The caller is responsible for trimming.
 */
export function extractLfnChars(entry: Uint8Array): string {
  const chars: string[] = [];
  const regions: Array<[number, number]> = [
    [LFN_NAME1_OFFSET, LFN_NAME1_CHARS],
    [LFN_NAME2_OFFSET, LFN_NAME2_CHARS],
    [LFN_NAME3_OFFSET, LFN_NAME3_CHARS],
  ];
  for (const [offset, count] of regions) {
    for (let i = 0; i < count; i++) {
      const lo = entry[offset + i * 2]!;
      const hi = entry[offset + i * 2 + 1]!;
      const code = lo | (hi << 8);
      if (code === 0xffff) return chars.join('');
      if (code === 0x0000) return chars.join('');
      chars.push(String.fromCharCode(code));
    }
  }
  return chars.join('');
}

export const LFN_CONST = {
  CHARS_PER_LFN_ENTRY,
  LFN_LAST_ENTRY_MASK,
};
