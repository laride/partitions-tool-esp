import { crc32Nvs } from '../common/crc32.js';
import {
  createWarningSink,
  emitWarning,
  formatWarning,
  type ParseWarning,
  type WarningOptions,
} from '../common/diagnostics.js';
import { NotAlignedError } from '../common/errors.js';
import { asciiDecode, BinaryReader, trimNull } from '../common/binary.js';
import {
  BITMAP_SIZE,
  CHUNK_ANY,
  ENTRIES_PER_PAGE,
  ENTRY_SIZE,
  ENTRY_STATE_NAME,
  FIRST_ENTRY_OFFSET,
  HEADER_SIZE,
  ITEM_TYPE,
  ITEM_TYPE_NAME,
  PAGE_SIZE,
  PAGE_STATE_CORRUPTED,
  PAGE_STATE_EMPTY,
  PAGE_STATE_NAME,
} from './constants.js';
import { decryptNvsPartition, type NvsEncryptionKey } from './crypto.js';

/** Matches `nvs::VerOffset::VER_0_OFFSET` in ESP-IDF. */
const VER_0_OFFSET = 0x00;
/** Matches `nvs::VerOffset::VER_1_OFFSET` in ESP-IDF. */
const VER_1_OFFSET = 0x80;

export type EntryState = 'Empty' | 'Written' | 'Erased' | 'Invalid';
export type PageState = 'Empty' | 'Active' | 'Full' | 'Erasing' | 'Corrupted' | 'Invalid';

export interface NvsEntryDump {
  index: number;
  state: EntryState;
  raw: Uint8Array;
  namespace: number;
  type: string;
  span: number;
  chunkIndex: number;
  key: string;
  headerCrc: { stored: number; computed: number; ok: boolean };
  /** For primitives: parsed value. For varlen: `{ size, crc }` or `{ size, chunkCount, chunkStart }`. */
  data: NvsDataValue | null;
  /** Inline continuation entries immediately following this entry within the same page span. */
  children: NvsEntryDump[];
  /** Cross-page `blob_data` chunks linked through a `blob_index` entry, if any. */
  blobChunks: NvsEntryDump[];
  /** For multi-span varlen entries: CRC comparison of the concatenated data. */
  dataCrc?: { stored: number; computed: number; ok: boolean };
  /** Reconstructed payload bytes for variable-length entries, if available. */
  valueBytes?: Uint8Array;
}

export type NvsDataValue =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'varlen-header'; size: number; crc: number }
  | { kind: 'blob-index'; size: number; chunkCount: number; chunkStart: number };

export interface NvsPageDump {
  startAddress: number;
  isEmpty: boolean;
  rawHeader: Uint8Array;
  rawBitmap: Uint8Array;
  header: {
    status: PageState;
    pageIndex: number;
    version: number;
    crc: { stored: number; computed: number; ok: boolean };
  };
  entries: NvsEntryDump[];
}

export interface NvsPartitionDump {
  pageSize: number;
  pages: NvsPageDump[];
  warnings: ParseWarning[];
}

export interface NvsParseOptions extends WarningOptions {
  /**
   * NVS decryption key. When provided, the image is decrypted before parsing
   * using AES-256-XTS (matching ESP-IDF's NVS encryption scheme).
   */
  decryptionKey?: NvsEncryptionKey;
}

/**
 * Parse an NVS partition binary. Matches the layered layout described in
 * `nvs_parser.py` (v2022+): 4KB pages, each with a 32B header, 32B entry-state
 * bitmap, and up to 126 32B entries.
 *
 * Compatibility note: unlike IDF runtime validation, this parser is designed
 * as a best-effort inspection tool. Structural issues are surfaced as warnings
 * whenever recovery is still possible. Multipage blobs are reconstructed by
 * selecting the newest `blob_index` per key (highest page sequence number) and
 * matching `blob_data` chunks within the active `chunkStart` version range.
 */
export function parse(image: Uint8Array, opts: NvsParseOptions = {}): NvsPartitionDump {
  const warningSink = createWarningSink(opts.onWarning);
  if (image.length % PAGE_SIZE !== 0) {
    throw new NotAlignedError(`NVS image length ${image.length} is not aligned to ${PAGE_SIZE}`);
  }
  const data = opts.decryptionKey ? decryptNvsPartition(image, opts.decryptionKey) : image;
  const pages: NvsPageDump[] = [];
  for (let addr = 0; addr < data.length; addr += PAGE_SIZE) {
    pages.push(parsePage(data.subarray(addr, addr + PAGE_SIZE), addr, warningSink));
  }
  rebuildMultiPageBlobs(pages, warningSink);
  return { pageSize: PAGE_SIZE, pages, warnings: warningSink.warnings };
}

function parsePage(
  buf: Uint8Array,
  startAddress: number,
  warningSink: ReturnType<typeof createWarningSink>,
): NvsPageDump {
  const isEmpty = buf.every((b) => b === 0xff);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const statusRaw = view.getUint32(0, true);
  const effectiveStatusRaw =
    statusRaw === PAGE_STATE_EMPTY && !isEmpty ? PAGE_STATE_CORRUPTED : statusRaw;
  const pageIndex = view.getUint32(4, true);
  const versionRaw = buf[8]!;
  const storedCrc = view.getUint32(28, true);
  const computedCrc = crc32Nvs(buf.subarray(4, 28)) >>> 0;
  if (!isEmpty && storedCrc !== computedCrc) {
    emitWarning(
      warningSink,
      formatWarning(
        'NVS',
        `page 0x${startAddress.toString(16)}`,
        `bad header CRC (stored=0x${storedCrc.toString(16)}, computed=0x${computedCrc.toString(16)})`,
      ),
    );
  }

  // Entry-state bitmap: 256 bits, 2 bits per slot.
  const bitmap = buf.subarray(HEADER_SIZE, HEADER_SIZE + BITMAP_SIZE);
  const states: EntryState[] = [];
  for (let i = 0; i < BITMAP_SIZE; i++) {
    const c = bitmap[i]!;
    for (let k = 0; k < 8; k += 2) {
      const s = (c >> k) & 3;
      states.push((ENTRY_STATE_NAME[s] as EntryState) ?? 'Invalid');
    }
  }
  states.length = ENTRIES_PER_PAGE;

  const entries: NvsEntryDump[] = [];
  let i = 0;
  while (i < ENTRIES_PER_PAGE) {
    const entryOffset = FIRST_ENTRY_OFFSET + i * ENTRY_SIZE;
    const rawEntry = buf.subarray(entryOffset, entryOffset + ENTRY_SIZE);
    let span = rawEntry[2]!;
    if (span === 0xff || span === 0) span = 1;

    const entry = decodeEntry(rawEntry, i, states[i] ?? 'Invalid', startAddress, warningSink);

    // Collect children for varlen spans so we can verify data CRC.
    if (span > 1) {
      const children: NvsEntryDump[] = [];
      for (let j = 1; j < span; j++) {
        const childIdx = i + j;
        if (childIdx >= ENTRIES_PER_PAGE) break;
        const off = FIRST_ENTRY_OFFSET + childIdx * ENTRY_SIZE;
        const childRaw = buf.subarray(off, off + ENTRY_SIZE);
        children.push(
          decodeEntry(childRaw, childIdx, states[childIdx] ?? 'Invalid', startAddress, warningSink),
        );
      }
      entry.children = children;

      // Verify aggregated data CRC.
      if (entry.data?.kind === 'varlen-header') {
        const valueBytes = reconstructInlineVarlenBytes(entry);
        if (valueBytes) {
          entry.valueBytes = valueBytes;
          const computed = crc32Nvs(valueBytes) >>> 0;
          entry.dataCrc = { stored: entry.data.crc, computed, ok: computed === entry.data.crc };
        }
        if (entry.dataCrc && !entry.dataCrc.ok) {
          emitWarning(
            warningSink,
            formatWarning(
              'NVS',
              `entry ${entry.key ?? '(unknown)'} at page 0x${startAddress.toString(16)} index ${entry.index}`,
              'bad data CRC',
            ),
          );
        }
      }
    }
    entries.push(entry);
    i += span;
  }

  return {
    startAddress,
    isEmpty,
    rawHeader: new Uint8Array(buf.subarray(0, HEADER_SIZE)),
    rawBitmap: new Uint8Array(bitmap),
    header: {
      status: (PAGE_STATE_NAME[effectiveStatusRaw] as PageState) ?? 'Invalid',
      pageIndex,
      version: 256 - versionRaw,
      crc: { stored: storedCrc, computed: computedCrc, ok: storedCrc === computedCrc },
    },
    entries,
  };
}

function decodeEntry(
  raw: Uint8Array,
  index: number,
  state: EntryState,
  pageAddress: number,
  warningSink: ReturnType<typeof createWarningSink>,
): NvsEntryDump {
  const reader = new BinaryReader(raw);
  const namespace = reader.u8();
  const entryType = reader.u8();
  const span = reader.u8();
  const chunkIndex = reader.u8();
  const crcStored = reader.u32();
  const keyBytes = reader.bytes(16);
  const dataBytes = reader.bytes(8);

  const crcBuffer = new Uint8Array(28);
  crcBuffer.set(raw.subarray(0, 4), 0);
  crcBuffer.set(raw.subarray(8, 32), 4);
  const crcComputed = crc32Nvs(crcBuffer) >>> 0;

  const { key, keyWarnings } = decodeKey(keyBytes);
  if (state === 'Written') {
    for (const reason of keyWarnings) {
      emitWarning(
        warningSink,
        formatWarning(
          'NVS',
          `written entry ${key || '(empty)'} at page 0x${pageAddress.toString(16)} index ${index}`,
          reason,
        ),
      );
    }
  }
  if (state === 'Written' && crcStored !== crcComputed) {
    emitWarning(
      warningSink,
      formatWarning(
        'NVS',
        `written entry ${key ?? '(unknown)'} at page 0x${pageAddress.toString(16)} index ${index}`,
        'bad header CRC',
      ),
    );
  }
  if (state === 'Written') {
    validateEntryHeader(
      index,
      entryType,
      span,
      chunkIndex,
      dataBytes,
      pageAddress,
      key,
      warningSink,
    );
  }

  return {
    index,
    state,
    raw: new Uint8Array(raw),
    namespace,
    type: ITEM_TYPE_NAME[entryType] ?? `0x${entryType.toString(16).padStart(2, '0')}`,
    span,
    chunkIndex,
    key,
    headerCrc: { stored: crcStored, computed: crcComputed, ok: crcStored === crcComputed },
    data: decodeData(entryType, dataBytes),
    children: [],
    blobChunks: [],
  };
}

function decodeKey(bytes: Uint8Array): { key: string; keyWarnings: string[] } {
  const key = trimNull(asciiDecode(bytes));
  const keyWarnings: string[] = [];
  if (key.length === 0) {
    keyWarnings.push('empty key');
  }
  if (key.length > 15) {
    keyWarnings.push('key exceeds NVS_KEY_NAME_MAX_SIZE-1 (15 characters)');
  }
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      keyWarnings.push('non-printable characters in key');
      break;
    }
  }
  return { key, keyWarnings };
}

function decodeData(entryType: number, data: Uint8Array): NvsDataValue | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (entryType) {
    case ITEM_TYPE.u8:
      return { kind: 'int', value: BigInt(data[0]!) };
    case ITEM_TYPE.i8: {
      const v = view.getInt8(0);
      return { kind: 'int', value: BigInt(v) };
    }
    case ITEM_TYPE.u16:
      return { kind: 'int', value: BigInt(view.getUint16(0, true)) };
    case ITEM_TYPE.i16:
      return { kind: 'int', value: BigInt(view.getInt16(0, true)) };
    case ITEM_TYPE.u32:
      return { kind: 'int', value: BigInt(view.getUint32(0, true)) };
    case ITEM_TYPE.i32:
      return { kind: 'int', value: BigInt(view.getInt32(0, true)) };
    case ITEM_TYPE.u64:
      return { kind: 'int', value: view.getBigUint64(0, true) };
    case ITEM_TYPE.i64:
      return { kind: 'int', value: view.getBigInt64(0, true) };
    case ITEM_TYPE.float:
      return { kind: 'float', value: view.getFloat32(0, true) };
    case ITEM_TYPE.double:
      return { kind: 'float', value: view.getFloat64(0, true) };
    case ITEM_TYPE.string:
    case ITEM_TYPE.blob:
    case ITEM_TYPE.blob_data: {
      const size = view.getUint16(0, true);
      const crc = view.getUint32(4, true);
      return { kind: 'varlen-header', size, crc };
    }
    case ITEM_TYPE.blob_index: {
      const size = view.getUint32(0, true);
      const chunkCount = data[4]!;
      const chunkStart = data[5]!;
      return { kind: 'blob-index', size, chunkCount, chunkStart };
    }
    default:
      return null;
  }
}

function validateEntryHeader(
  index: number,
  entryType: number,
  span: number,
  chunkIndex: number,
  data: Uint8Array,
  pageAddress: number,
  key: string,
  warningSink: ReturnType<typeof createWarningSink>,
): void {
  const subject = `written entry ${key || '(empty)'} at page 0x${pageAddress.toString(16)} index ${index}`;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (
    entryType === ITEM_TYPE.u8 ||
    entryType === ITEM_TYPE.i8 ||
    entryType === ITEM_TYPE.u16 ||
    entryType === ITEM_TYPE.i16 ||
    entryType === ITEM_TYPE.u32 ||
    entryType === ITEM_TYPE.i32 ||
    entryType === ITEM_TYPE.u64 ||
    entryType === ITEM_TYPE.i64 ||
    entryType === ITEM_TYPE.float ||
    entryType === ITEM_TYPE.double
  ) {
    if (span !== 1) {
      emitWarning(
        warningSink,
        formatWarning('NVS', subject, `invalid span ${span} for fixed-width type`),
      );
    }
    return;
  }

  if (entryType === ITEM_TYPE.blob_index) {
    if (span !== 1) {
      emitWarning(
        warningSink,
        formatWarning('NVS', subject, `invalid span ${span} for blob_index`),
      );
    }
    if (chunkIndex !== 0xff) {
      emitWarning(
        warningSink,
        formatWarning(
          'NVS',
          subject,
          `invalid chunk index 0x${chunkIndex.toString(16)} for blob_index`,
        ),
      );
    }
    const maxDataSize = Math.floor((0xff / 2) * (ENTRIES_PER_PAGE - 1) * ENTRY_SIZE);
    if (view.getUint32(0, true) > maxDataSize) {
      emitWarning(
        warningSink,
        formatWarning(
          'NVS',
          subject,
          `blob_index data length ${view.getUint32(0, true)} exceeds max theoretical size ${maxDataSize}`,
        ),
      );
    }
    return;
  }

  if (
    entryType !== ITEM_TYPE.string &&
    entryType !== ITEM_TYPE.blob &&
    entryType !== ITEM_TYPE.blob_data
  ) {
    emitWarning(
      warningSink,
      formatWarning(
        'NVS',
        subject,
        `invalid datatype 0x${entryType.toString(16).padStart(2, '0')}`,
      ),
    );
    return;
  }

  if (entryType === ITEM_TYPE.blob_data && chunkIndex === 0xff) {
    emitWarning(
      warningSink,
      formatWarning('NVS', subject, 'invalid chunk index 0xff for blob_data'),
    );
  }

  const dataSize = view.getUint16(0, true);
  const maxAvailableData = (ENTRIES_PER_PAGE - index - 1) * ENTRY_SIZE;
  if (dataSize > maxAvailableData) {
    emitWarning(
      warningSink,
      formatWarning(
        'NVS',
        subject,
        `variable data length ${dataSize} exceeds page tail capacity ${maxAvailableData}`,
      ),
    );
  }

  const maxAvailableSpan = ENTRIES_PER_PAGE - index;
  if (span > maxAvailableSpan) {
    emitWarning(
      warningSink,
      formatWarning('NVS', subject, `span ${span} exceeds page tail span ${maxAvailableSpan}`),
    );
  }

  const spanCalcFromLen = Math.ceil(dataSize / ENTRY_SIZE) + 1;
  if (span !== spanCalcFromLen) {
    emitWarning(
      warningSink,
      formatWarning(
        'NVS',
        subject,
        `span ${span} does not match calculated span ${spanCalcFromLen}`,
      ),
    );
  }
}

function reconstructInlineVarlenBytes(entry: NvsEntryDump): Uint8Array | undefined {
  if (entry.data?.kind !== 'varlen-header') return undefined;
  if (entry.children.length !== Math.max(entry.span - 1, 0)) return undefined;
  const merged = new Uint8Array(entry.children.length * ENTRY_SIZE);
  for (let i = 0; i < entry.children.length; i++)
    merged.set(entry.children[i]!.raw, i * ENTRY_SIZE);
  return merged.subarray(0, entry.data.size);
}

interface LocatedEntry {
  page: NvsPageDump;
  pageAddress: number;
  pageIndex: number;
  entry: NvsEntryDump;
}

function compareEntryLocation(
  a: { pageIndex: number; entryIndex: number },
  b: { pageIndex: number; entryIndex: number },
): number {
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
  return a.entryIndex - b.entryIndex;
}

/** Whether `chunkIndex` belongs to the chunk family described by a `blob_index` entry. */
function chunkIndexInBlobFamily(
  chunkIndex: number,
  chunkStart: number,
  chunkCount: number,
): boolean {
  if (chunkIndex < chunkStart || chunkIndex >= chunkStart + chunkCount) return false;
  const upper = chunkStart === VER_0_OFFSET ? VER_1_OFFSET : CHUNK_ANY;
  return chunkIndex < upper;
}

function pickNewestEntry(candidates: LocatedEntry[]): LocatedEntry {
  return [...candidates].sort((a, b) =>
    compareEntryLocation(
      { pageIndex: a.pageIndex, entryIndex: a.entry.index },
      { pageIndex: b.pageIndex, entryIndex: b.entry.index },
    ),
  )[candidates.length - 1]!;
}

function rebuildMultiPageBlobs(
  pages: NvsPageDump[],
  warningSink: ReturnType<typeof createWarningSink>,
): void {
  const located: LocatedEntry[] = pages.flatMap((page) =>
    page.entries
      .filter((entry) => entry.state === 'Written')
      .map((entry) => ({
        page,
        pageAddress: page.startAddress,
        pageIndex: page.header.pageIndex,
        entry,
      })),
  );

  const blobIndexGroups = new Map<string, LocatedEntry[]>();
  for (const item of located) {
    if (item.entry.type !== 'blob_index' || item.entry.data?.kind !== 'blob-index') continue;
    const groupKey = `${item.entry.namespace}:${item.entry.key}`;
    const group = blobIndexGroups.get(groupKey);
    if (group) group.push(item);
    else blobIndexGroups.set(groupKey, [item]);
  }

  const activeBlobIndexes = new Map<string, LocatedEntry>();
  for (const [groupKey, candidates] of blobIndexGroups) {
    const winner = pickNewestEntry(candidates);
    activeBlobIndexes.set(groupKey, winner);
    if (candidates.length > 1) {
      for (const stale of candidates) {
        if (stale === winner) continue;
        emitWarning(
          warningSink,
          formatWarning(
            'NVS',
            `written entry ${stale.entry.key} at page 0x${stale.pageAddress.toString(16)} index ${stale.entry.index}`,
            `stale blob_index superseded by page seq ${winner.pageIndex} index ${winner.entry.index}`,
          ),
        );
      }
    }
  }

  const blobDataEntries = located.filter((item) => item.entry.type === 'blob_data');
  const usedBlobData = new Set<NvsEntryDump>();

  for (const { pageAddress, entry } of activeBlobIndexes.values()) {
    if (entry.data?.kind !== 'blob-index') continue;

    const subject = `written entry ${entry.key} at page 0x${pageAddress.toString(16)} index ${entry.index}`;
    const chunksByIndex = new Map<number, LocatedEntry[]>();
    for (const candidate of blobDataEntries) {
      const chunk = candidate.entry;
      if (chunk.key !== entry.key || chunk.namespace !== entry.namespace) continue;
      if (!chunkIndexInBlobFamily(chunk.chunkIndex, entry.data.chunkStart, entry.data.chunkCount)) {
        continue;
      }
      const matches = chunksByIndex.get(chunk.chunkIndex);
      if (matches) matches.push(candidate);
      else chunksByIndex.set(chunk.chunkIndex, [candidate]);
    }

    const chunks: NvsEntryDump[] = [];
    const payloadParts: Uint8Array[] = [];
    for (let offset = 0; offset < entry.data.chunkCount; offset++) {
      const expectedChunkIndex = entry.data.chunkStart + offset;
      const matches = chunksByIndex.get(expectedChunkIndex) ?? [];
      if (matches.length === 0) {
        emitWarning(
          warningSink,
          formatWarning(
            'NVS',
            subject,
            `missing blob_data chunk 0x${expectedChunkIndex.toString(16)}`,
          ),
        );
        continue;
      }
      const chunkRef = pickNewestEntry(matches);
      if (matches.length > 1) {
        emitWarning(
          warningSink,
          formatWarning(
            'NVS',
            subject,
            `duplicate blob_data chunks for chunk index 0x${expectedChunkIndex.toString(16)}; selected page seq ${chunkRef.pageIndex} index ${chunkRef.entry.index}`,
          ),
        );
      }
      const chunk = chunkRef.entry;
      chunks.push(chunk);
      usedBlobData.add(chunk);
      const bytes = reconstructInlineVarlenBytes(chunk);
      if (!bytes) {
        emitWarning(
          warningSink,
          formatWarning(
            'NVS',
            subject,
            `blob_data chunk 0x${expectedChunkIndex.toString(16)} cannot be reconstructed`,
          ),
        );
        continue;
      }
      chunk.valueBytes ??= bytes;
      payloadParts.push(bytes);
    }

    entry.blobChunks = chunks;

    if (chunks.length !== entry.data.chunkCount) {
      emitWarning(
        warningSink,
        formatWarning(
          'NVS',
          subject,
          `blob_index chunk count ${entry.data.chunkCount} does not match reconstructed chunks ${chunks.length}`,
        ),
      );
      continue;
    }

    const total = payloadParts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(total);
    let cursor = 0;
    for (const part of payloadParts) {
      merged.set(part, cursor);
      cursor += part.length;
    }
    entry.valueBytes = merged.subarray(0, entry.data.size);

    if (total !== entry.data.size) {
      emitWarning(
        warningSink,
        formatWarning(
          'NVS',
          subject,
          `blob_index data length ${entry.data.size} does not match reconstructed payload ${total}`,
        ),
      );
    }
  }

  for (const candidate of blobDataEntries) {
    if (usedBlobData.has(candidate.entry)) continue;
    const groupKey = `${candidate.entry.namespace}:${candidate.entry.key}`;
    const active = activeBlobIndexes.get(groupKey);
    if (!active || active.entry.data?.kind !== 'blob-index') continue;
    const meta = active.entry.data;
    if (chunkIndexInBlobFamily(candidate.entry.chunkIndex, meta.chunkStart, meta.chunkCount)) {
      continue;
    }
    const activeSubject = `active blob_index for ${candidate.entry.key} (page seq ${active.pageIndex})`;
    if (
      candidate.entry.chunkIndex >= VER_0_OFFSET &&
      candidate.entry.chunkIndex < VER_1_OFFSET &&
      meta.chunkStart === VER_1_OFFSET
    ) {
      emitWarning(
        warningSink,
        formatWarning(
          'NVS',
          `written entry ${candidate.entry.key} at page 0x${candidate.pageAddress.toString(16)} index ${candidate.entry.index}`,
          `orphaned blob_data chunk 0x${candidate.entry.chunkIndex.toString(16)} outside ${activeSubject} version range`,
        ),
      );
    } else if (
      candidate.entry.chunkIndex >= VER_1_OFFSET &&
      candidate.entry.chunkIndex < CHUNK_ANY &&
      meta.chunkStart === VER_0_OFFSET
    ) {
      emitWarning(
        warningSink,
        formatWarning(
          'NVS',
          `written entry ${candidate.entry.key} at page 0x${candidate.pageAddress.toString(16)} index ${candidate.entry.index}`,
          `orphaned blob_data chunk 0x${candidate.entry.chunkIndex.toString(16)} outside ${activeSubject} version range`,
        ),
      );
    }
  }
}
