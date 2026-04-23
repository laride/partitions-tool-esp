import { crc32Nvs } from '../common/crc32.js';
import { NotAlignedError } from '../common/errors.js';
import { asciiDecode, BinaryReader, trimNull } from '../common/binary.js';
import {
  BITMAP_SIZE,
  ENTRIES_PER_PAGE,
  ENTRY_SIZE,
  ENTRY_STATE_NAME,
  FIRST_ENTRY_OFFSET,
  HEADER_SIZE,
  ITEM_TYPE,
  ITEM_TYPE_NAME,
  PAGE_SIZE,
  PAGE_STATE_NAME,
} from './constants.js';

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
  key: string | null;
  headerCrc: { stored: number; computed: number; ok: boolean };
  /** For primitives: parsed value. For varlen: `{ size, crc }` or `{ size, chunkCount, chunkStart }`. */
  data: NvsDataValue | null;
  /** Children BLOB_DATA entries contributing to this BLOB_IDX span, if any. */
  children: NvsEntryDump[];
  /** For multi-span varlen entries: CRC comparison of the concatenated data. */
  dataCrc?: { stored: number; computed: number; ok: boolean };
}

export type NvsDataValue =
  | { kind: 'int'; value: bigint }
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
}

/**
 * Parse an NVS partition binary. Matches the layered layout described in
 * `nvs_parser.py` (v2022+): 4KB pages, each with a 32B header, 32B entry-state
 * bitmap, and up to 126 32B entries.
 */
export function parse(image: Uint8Array): NvsPartitionDump {
  if (image.length % PAGE_SIZE !== 0) {
    throw new NotAlignedError(`NVS image length ${image.length} is not aligned to ${PAGE_SIZE}`);
  }
  const pages: NvsPageDump[] = [];
  for (let addr = 0; addr < image.length; addr += PAGE_SIZE) {
    pages.push(parsePage(image.subarray(addr, addr + PAGE_SIZE), addr));
  }
  return { pageSize: PAGE_SIZE, pages };
}

function parsePage(buf: Uint8Array, startAddress: number): NvsPageDump {
  const isEmpty = buf.subarray(0, ENTRY_SIZE).every((b) => b === 0xff);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const statusRaw = view.getUint32(0, true);
  const pageIndex = view.getUint32(4, true);
  const versionRaw = buf[8]!;
  const storedCrc = view.getUint32(28, true);
  const computedCrc = crc32Nvs(buf.subarray(4, 28)) >>> 0;

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

  const entries: NvsEntryDump[] = [];
  let i = 0;
  while (i < ENTRIES_PER_PAGE) {
    const entryOffset = FIRST_ENTRY_OFFSET + i * ENTRY_SIZE;
    const rawEntry = buf.subarray(entryOffset, entryOffset + ENTRY_SIZE);
    let span = rawEntry[2]!;
    if (span === 0xff || span === 0) span = 1;

    const entry = decodeEntry(rawEntry, i, states[i] ?? 'Invalid');

    // Collect children for varlen spans so we can verify data CRC.
    if (span > 1) {
      const children: NvsEntryDump[] = [];
      for (let j = 1; j < span; j++) {
        const childIdx = i + j;
        if (childIdx >= ENTRIES_PER_PAGE) break;
        const off = FIRST_ENTRY_OFFSET + childIdx * ENTRY_SIZE;
        const childRaw = buf.subarray(off, off + ENTRY_SIZE);
        children.push(decodeEntry(childRaw, childIdx, states[childIdx] ?? 'Invalid'));
      }
      entry.children = children;

      // Verify aggregated data CRC.
      if (entry.data?.kind === 'varlen-header') {
        const merged = new Uint8Array((span - 1) * ENTRY_SIZE);
        for (let j = 0; j < children.length; j++) merged.set(children[j]!.raw, j * ENTRY_SIZE);
        const sliced = merged.subarray(0, entry.data.size);
        const computed = crc32Nvs(sliced) >>> 0;
        entry.dataCrc = { stored: entry.data.crc, computed, ok: computed === entry.data.crc };
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
      status: (PAGE_STATE_NAME[statusRaw] as PageState) ?? 'Invalid',
      pageIndex,
      version: 256 - versionRaw,
      crc: { stored: storedCrc, computed: computedCrc, ok: storedCrc === computedCrc },
    },
    entries,
  };
}

function decodeEntry(raw: Uint8Array, index: number, state: EntryState): NvsEntryDump {
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

  const key = decodeKey(keyBytes);

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
    data: key === null ? null : decodeData(entryType, dataBytes),
    children: [],
  };
}

function decodeKey(bytes: Uint8Array): string | null {
  const s = trimNull(asciiDecode(bytes));
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return null;
  }
  return s;
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
