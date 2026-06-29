import { asciiEncode } from '../common/binary.js';
import { InputError } from '../common/errors.js';
import { ATTR_LONG_NAME, ENTRY_SIZE, MAX_EXT_SIZE, MAX_NAME_SIZE, PAD_CHAR } from './constants.js';

const CHARS_PER_LFN_ENTRY = 13;
const LFN_LAST_ENTRY_MASK = 0x40;
const LFN_NAME1_OFFSET = 1;
const LFN_NAME1_CHARS = 5;
const LFN_NAME2_OFFSET = 14;
const LFN_NAME2_CHARS = 6;
const LFN_NAME3_OFFSET = 28;
const LFN_NAME3_CHARS = 2;
const MAX_LFN_COLLISION_ORDER = 127;

/**
 * Invalid characters for a short (8.3) filename in FatFs' DOS/OEM dialect.
 * Some of them are valid in LFN entries, so they trigger LFN rather than a
 * hard failure.
 */
const INVALID_SFN_ASCII = new Set('"*+,./:;<=>?[\\]|');
const INVALID_LFN_ASCII = new Set('"*/:<>?[\\]|');

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
  if (!isAscii(filename)) return true;
  if (hasInvalidShortNameChar(name) || hasInvalidShortNameChar(ext)) return true;
  if (name.length > MAX_NAME_SIZE || ext.length > MAX_EXT_SIZE) return true;
  // Any lowercase content requires LFN under ESP-IDF rules.
  if (filename !== filename.toUpperCase()) return true;
  return false;
}

export function validateFatfsFilename(filename: string): void {
  if (filename.length === 0) throw new InputError('FatFS filename must not be empty');
  if (filename === '.' || filename === '..') {
    throw new InputError(`FatFS filename '${filename}' is reserved`);
  }
  if (filename.endsWith('.')) {
    throw new InputError(`FatFS filename '${filename}' must not end with a dot`);
  }
  if (hasInvalidLongNameChar(filename)) {
    throw new InputError(`FatFS filename '${filename}' contains a character not accepted by FatFs`);
  }
}

export interface ShortAlias {
  /** Raw 11-byte `DIR_Name` + `DIR_Name_ext` as it will land on disk. */
  bytes11: Uint8Array;
  /** Human-readable `name + '.' + ext` (uppercased). */
  display: string;
  /** Numeric order used to generate the `~N` suffix (1-based). */
  order: number;
}

function buildLfnRecordName(longName: string): string {
  return longName.length % CHARS_PER_LFN_ENTRY === 0 ? longName : longName + '\0';
}

function genNumnameSuffix(seq: number, lfn: string): string {
  if (seq > 5) {
    let sreg = seq;
    for (let idx = 0; idx < lfn.length; idx++) {
      let wc = lfn.charCodeAt(idx);
      for (let i = 0; i < 16; i++) {
        sreg = (sreg << 1) + (wc & 1);
        wc >>>= 1;
        if (sreg & 0x10000) sreg ^= 0x11021;
      }
    }
    seq = sreg & 0xffff;
  }
  return `~${seq.toString(16).toUpperCase()}`;
}

function shortKey(bytes11: Uint8Array): string {
  return Array.from(bytes11, (v) => String.fromCharCode(v)).join('');
}

/**
 * Produce a unique short alias for {@link longName} given the 11-byte short
 * aliases that already exist in the same directory. Matches current
 * ESP-IDF/FatFs `gen_numname()` behavior.
 */
export function buildShortAlias(longName: string, usedShortNames: Set<string>): ShortAlias {
  const upper = uppercaseAscii(longName);
  const dot = upper.lastIndexOf('.');
  const name = dot < 0 ? upper : upper.slice(0, dot);
  const ext = dot < 0 ? '' : upper.slice(dot + 1);
  const lfnRecord = buildLfnRecordName(dot < 0 ? upper : `${name}.${ext}`);
  const sanitized = sanitizeShortPart(name, '_');
  const shortExt = sanitizeShortPart(ext, '').slice(0, 3);

  for (let order = 1; order <= MAX_LFN_COLLISION_ORDER; order++) {
    const suffix = genNumnameSuffix(order, lfnRecord);
    const shortName = `${sanitized.slice(0, Math.max(0, MAX_NAME_SIZE - suffix.length))}${suffix}`;
    const bytes11 = new Uint8Array(11).fill(PAD_CHAR);
    bytes11.set(asciiEncode(shortName), 0);
    bytes11.set(asciiEncode(shortExt), 8);
    const key = shortKey(bytes11);
    if (usedShortNames.has(key)) continue;
    usedShortNames.add(key);

    const displayName = Array.from(bytes11.subarray(0, 8), (v) => String.fromCharCode(v))
      .join('')
      .trimEnd();
    const displayExt = Array.from(bytes11.subarray(8, 11), (v) => String.fromCharCode(v))
      .join('')
      .trimEnd();
    const display = displayExt ? `${displayName}.${displayExt}` : displayName;
    return { bytes11, display, order };
  }
  throw new Error(`LFN collision order exceeded ${MAX_LFN_COLLISION_ORDER} for '${longName}'`);
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function hasInvalidShortNameChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code > 0x7f || INVALID_SFN_ASCII.has(value[i]!)) return true;
  }
  return false;
}

function hasInvalidLongNameChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || INVALID_LFN_ASCII.has(value[i]!)) return true;
  }
  return false;
}

function uppercaseAscii(value: string): string {
  return value.replace(/[a-z]/g, (ch) => ch.toUpperCase());
}

function sanitizeShortPart(value: string, fallback: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = value[i]!;
    out += code <= 0x7f && !hasInvalidShortNameChar(ch) ? ch : '_';
  }
  out = out.replace(/_+/g, '_');
  return out.length > 0 ? out : fallback;
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
  const padded = buildLfnRecordName(longName);
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
      if (opts.espIdfCompat) {
        const lower = String.fromCharCode(code).toLowerCase();
        if (lower.length === 1) code = lower.charCodeAt(0);
      }
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
