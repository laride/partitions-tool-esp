import { crc32Nvs } from '../common/crc32.js';
import { InputError } from '../common/errors.js';
import { asciiEncode, utf8Encode } from '../common/binary.js';
import {
  BITMAP_SIZE,
  CHUNK_ANY,
  ENTRIES_PER_PAGE,
  ENTRY_SIZE,
  FIRST_ENTRY_OFFSET,
  HEADER_SIZE,
  ITEM_TYPE,
  MAX_BLOB_SIZE,
  PAGE_SIZE,
  PAGE_STATE_ACTIVE,
  PAGE_STATE_FULL,
  PrimitiveType,
  VERSION1,
  VERSION2,
  VarlenType,
} from './constants.js';

export type NvsVersion = typeof VERSION1 | typeof VERSION2;

/**
 * Logical NVS entry definition. `namespace` creates a namespace row. All
 * other types carry a key, encoding and value.
 */
export type NvsEntryDef =
  | { type: 'namespace'; key: string }
  | { type: PrimitiveType; key: string; value: number | bigint | string }
  | { type: 'string'; key: string; value: string }
  | {
      type: 'binary';
      key: string;
      value: Uint8Array | string;
      encoding?: 'raw' | 'hex2bin' | 'base64';
    };

export interface NvsGenerateOptions {
  /** Partition size in bytes. Must be a multiple of 4096 and at least 0x3000. */
  size: number;
  /** Default v2 (multipage blobs). Passing 1 forces v1 behavior. */
  version?: 1 | 2;
}

class Page {
  readonly buf: Uint8Array = new Uint8Array(PAGE_SIZE).fill(0xff);
  readonly bitmap: Uint8Array = new Uint8Array(BITMAP_SIZE).fill(0xff);
  entryNum = 0;
  readonly version: number;
  readonly isReserved: boolean;
  readonly isEmpty: boolean;

  constructor(
    readonly pageNum: number,
    version: number,
    isEmpty = false,
    isReserved = false,
  ) {
    this.version = version;
    this.isReserved = isReserved;
    this.isEmpty = isEmpty;
    if (!isReserved && !isEmpty) this.writeHeader();
  }

  private writeHeader(): void {
    const hdr = new Uint8Array(HEADER_SIZE).fill(0xff);
    const view = new DataView(hdr.buffer);
    view.setUint32(0, PAGE_STATE_ACTIVE, true);
    view.setUint32(4, this.pageNum, true);
    hdr[8] = this.version;
    const crc = crc32Nvs(hdr.subarray(4, 28));
    view.setUint32(28, crc >>> 0, true);
    this.buf.set(hdr, 0);
  }

  markFull(): void {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const state = view.getUint32(0, true);
    if (state === PAGE_STATE_ACTIVE) view.setUint32(0, PAGE_STATE_FULL, true);
  }

  writeEntry(entry: Uint8Array, entryCount: number): void {
    if (entry.length !== ENTRY_SIZE * entryCount) {
      throw new Error(
        `internal: entry length ${entry.length} != expected ${ENTRY_SIZE * entryCount}`,
      );
    }
    const offset = FIRST_ENTRY_OFFSET + ENTRY_SIZE * this.entryNum;
    this.buf.set(entry, offset);
    for (let i = 0; i < entryCount; i++) this.markBitmapWritten();
  }

  private markBitmapWritten(): void {
    const bitNum = this.entryNum * 2;
    const byteIdx = bitNum >>> 3;
    const bitOffset = bitNum & 7;
    this.bitmap[byteIdx]! &= ~(1 << bitOffset) & 0xff;
    this.buf.set(this.bitmap, HEADER_SIZE);
    this.entryNum += 1;
  }

  get entriesRemaining(): number {
    return ENTRIES_PER_PAGE - this.entryNum;
  }
}

class PageFull extends Error {
  constructor() {
    super('page full');
  }
}

class InsufficientSizeError extends Error {
  constructor() {
    super('nvs size exhausted');
  }
}

class NvsWriter {
  pages: Page[] = [];
  namespaces: Map<string, number> = new Map();
  nsCount = 0;
  pageNum = -1;
  remainingSize: number;

  constructor(
    public readonly totalSize: number,
    public readonly version: number,
  ) {
    // esp_idf_nvs_partition_gen's `check_size` pre-reserves one page up front
    // (the final "reserved" page), so NVS.size starts at totalSize - PAGE_SIZE.
    this.remainingSize = totalSize - PAGE_SIZE;
    this.createPage();
  }

  private get current(): Page {
    return this.pages[this.pages.length - 1]!;
  }

  createPage(opts: { empty?: boolean; reserved?: boolean } = {}): Page {
    if (this.pages.length > 0 && !opts.empty) this.current.markFull();
    if (!opts.reserved && this.remainingSize === 0) {
      throw new InsufficientSizeError();
    }
    if (!opts.reserved) this.remainingSize -= PAGE_SIZE;
    this.pageNum += 1;
    const page = new Page(this.pageNum, this.version, !!opts.empty, !!opts.reserved);
    this.pages.push(page);
    return page;
  }

  finalize(): Uint8Array {
    // Emit empty pages until the partition is full, then one "reserved" empty
    // page. Matches the ESP-IDF `__exit__` loop.
    while (true) {
      try {
        this.createPage({ empty: true });
      } catch (e) {
        if (!(e instanceof InsufficientSizeError)) throw e;
        this.createPage({ empty: true, reserved: true });
        break;
      }
    }
    const out = new Uint8Array(this.totalSize);
    let off = 0;
    for (const p of this.pages) {
      out.set(p.buf, off);
      off += PAGE_SIZE;
    }
    return out;
  }

  writeNamespace(key: string): number {
    const existing = this.namespaces.get(key);
    if (existing !== undefined) return existing;
    this.nsCount += 1;
    const idx = this.nsCount;
    this.writePrimitive(key, BigInt(idx), 'u8', 0);
    this.namespaces.set(key, idx);
    return idx;
  }

  writePrimitive(key: string, value: bigint, encoding: PrimitiveType, nsIndex: number): void {
    try {
      this.writePrimitiveOnPage(this.current, key, value, encoding, nsIndex);
    } catch (e) {
      if (!(e instanceof PageFull)) throw e;
      this.createPage();
      this.writePrimitiveOnPage(this.current, key, value, encoding, nsIndex);
    }
  }

  writeVarlen(key: string, data: Uint8Array, encoding: VarlenType, nsIndex: number): void {
    try {
      this.writeVarlenOnPage(this.current, key, data, encoding, nsIndex);
    } catch (e) {
      if (!(e instanceof PageFull)) throw e;
      this.createPage();
      this.writeVarlenOnPage(this.current, key, data, encoding, nsIndex);
    }
  }

  private writePrimitiveOnPage(
    page: Page,
    key: string,
    value: bigint,
    encoding: PrimitiveType,
    nsIndex: number,
  ): void {
    if (page.entryNum >= ENTRIES_PER_PAGE) throw new PageFull();
    const entry = new Uint8Array(ENTRY_SIZE).fill(0xff);
    const view = new DataView(entry.buffer);
    entry[0] = nsIndex;
    entry[1] = ITEM_TYPE[encoding];
    entry[2] = 0x01;
    entry[3] = CHUNK_ANY;
    writeKey(entry, key);

    switch (encoding) {
      case 'u8':
        view.setUint8(24, Number(value) & 0xff);
        break;
      case 'i8':
        view.setInt8(24, Number(value));
        break;
      case 'u16':
        view.setUint16(24, Number(value) & 0xffff, true);
        break;
      case 'i16':
        view.setInt16(24, Number(value), true);
        break;
      case 'u32':
        view.setUint32(24, Number(value) >>> 0, true);
        break;
      case 'i32':
        view.setInt32(24, Number(value), true);
        break;
      case 'u64':
        view.setBigUint64(24, BigInt.asUintN(64, value), true);
        break;
      case 'i64':
        view.setBigInt64(24, BigInt.asIntN(64, value), true);
        break;
    }
    setEntryCrc(entry);
    page.writeEntry(entry, 1);
  }

  private writeVarlenOnPage(
    page: Page,
    key: string,
    data: Uint8Array,
    encoding: VarlenType,
    nsIndex: number,
  ): void {
    const dataLen = data.length;

    // V2 blob size limit only applies to strings; V1 limit applies to everything.
    const maxBlob = MAX_BLOB_SIZE[this.version as keyof typeof MAX_BLOB_SIZE];
    const blobLimitApplies = this.version === VERSION1 || encoding === 'string';
    if (blobLimitApplies && dataLen > maxBlob) {
      throw new InputError(
        `value for key '${key}' (${dataLen} bytes) exceeds max NVS blob size ${maxBlob}`,
      );
    }

    const rounded = (dataLen + 31) & ~31;
    const dataEntryCount = rounded / 32;
    const totalEntryCount = dataEntryCount + 1;

    if (page.entryNum >= ENTRIES_PER_PAGE) throw new PageFull();
    const canSplit = this.version === VERSION2 && encoding === 'binary';
    if (page.entryNum + totalEntryCount >= ENTRIES_PER_PAGE && !canSplit) {
      throw new PageFull();
    }

    const header = new Uint8Array(ENTRY_SIZE).fill(0xff);
    header[0] = nsIndex;
    header[3] = CHUNK_ANY;
    writeKey(header, key);
    if (this.version === VERSION2) {
      if (encoding === 'string') header[2] = dataEntryCount + 1;
    } else {
      header[2] = dataEntryCount + 1;
    }
    header[1] = encoding === 'string' ? ITEM_TYPE.string : ITEM_TYPE.blob;

    if (this.version === VERSION2 && encoding === 'binary') {
      this.writeMultiChunkBinary(page, header, data, dataLen, nsIndex);
    } else {
      this.writeSingleChunk(page, header, data, dataLen, dataEntryCount);
    }
  }

  private writeSingleChunk(
    page: Page,
    header: Uint8Array,
    data: Uint8Array,
    dataLen: number,
    dataEntryCount: number,
  ): void {
    const view = new DataView(header.buffer);
    view.setUint16(24, dataLen, true);
    view.setUint32(28, crc32Nvs(data) >>> 0, true);
    setEntryCrc(header);
    page.writeEntry(header, 1);
    const padded = new Uint8Array(dataEntryCount * ENTRY_SIZE).fill(0xff);
    padded.set(data.subarray(0, dataLen), 0);
    page.writeEntry(padded, dataEntryCount);
  }

  private writeMultiChunkBinary(
    page: Page,
    header: Uint8Array,
    data: Uint8Array,
    dataLen: number,
    nsIndex: number,
  ): void {
    let remaining = dataLen;
    let offset = 0;
    const chunkStart = 0;
    let chunkCount = 0;
    let current = page;

    while (true) {
      // Mutate header clone for each chunk.
      const entry = new Uint8Array(ENTRY_SIZE);
      entry.set(header, 0);
      const view = new DataView(entry.buffer);

      const tailroom = (ENTRIES_PER_PAGE - current.entryNum - 1) * ENTRY_SIZE;
      if (tailroom < 0) throw new Error('page overflow');
      const chunkSize = tailroom < remaining ? tailroom : remaining;
      remaining -= chunkSize;

      entry[1] = ITEM_TYPE.blob_data;
      const roundedChunk = (chunkSize + 31) & ~31;
      const chunkEntryCount = roundedChunk / 32;
      const chunkTotalCount = chunkEntryCount + 1;
      entry[2] = chunkTotalCount;
      entry[3] = chunkStart + chunkCount;

      view.setUint16(24, chunkSize, true);
      const dataChunk = data.subarray(offset, offset + chunkSize);
      view.setUint32(28, crc32Nvs(dataChunk) >>> 0, true);
      setEntryCrc(entry);
      current.writeEntry(entry, 1);
      const padded = new Uint8Array(chunkEntryCount * ENTRY_SIZE).fill(0xff);
      padded.set(dataChunk, 0);
      current.writeEntry(padded, chunkEntryCount);

      chunkCount += 1;

      if (remaining > 0 || tailroom - chunkSize < ENTRY_SIZE) {
        this.createPage();
        current = this.current;
      }

      offset += chunkSize;

      if (remaining === 0) {
        // Write BLOB_IDX entry.
        const idx = new Uint8Array(ENTRY_SIZE).fill(0xff);
        const idxView = new DataView(idx.buffer);
        idx[0] = nsIndex;
        idx[1] = ITEM_TYPE.blob_index;
        idx[2] = 1;
        idx[3] = CHUNK_ANY;
        writeKey(idx, asciiDecodeKey(header));
        idxView.setUint32(24, dataLen, true);
        idx[28] = chunkCount;
        idx[29] = chunkStart;
        // data[30..32] stays 0xFF
        setEntryCrc(idx);
        if (current.entryNum >= ENTRIES_PER_PAGE) {
          this.createPage();
          current = this.current;
        }
        current.writeEntry(idx, 1);
        return;
      }
    }
  }
}

function asciiDecodeKey(entry: Uint8Array): string {
  let end = 16;
  for (let i = 0; i < 16; i++) {
    if (entry[8 + i] === 0x00) {
      end = i;
      break;
    }
  }
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(entry[8 + i]!);
  return s;
}

function writeKey(entry: Uint8Array, key: string): void {
  if (key.length >= 16) throw new InputError(`NVS key '${key}' is too long (max 15 characters)`);
  const keyBytes = asciiEncode(key);
  entry.fill(0, 8, 24);
  entry.set(keyBytes, 8);
}

function setEntryCrc(entry: Uint8Array): void {
  const buf = new Uint8Array(28);
  buf.set(entry.subarray(0, 4), 0);
  buf.set(entry.subarray(8, 32), 4);
  const crc = crc32Nvs(buf) >>> 0;
  new DataView(entry.buffer, entry.byteOffset).setUint32(4, crc, true);
}

/**
 * Generate an NVS partition binary from a list of logical entries.
 *
 * The implementation mirrors ESP-IDF's `esp_idf_nvs_partition_gen`:
 *  - one reserved empty page at the end of the partition
 *  - v2 binary entries are allowed to span pages via BLOB_DATA/BLOB_IDX
 *  - namespaces are deduplicated and auto-assigned indices starting at 1
 */
export function generate(entries: NvsEntryDef[], opts: NvsGenerateOptions): Uint8Array {
  const version = opts.version === 1 ? VERSION1 : VERSION2;
  if (opts.size % PAGE_SIZE !== 0) {
    throw new InputError(`NVS size ${opts.size} must be a multiple of ${PAGE_SIZE}`);
  }
  if (opts.size < 3 * PAGE_SIZE) {
    throw new InputError(`NVS size ${opts.size} must be >= 0x3000 (3 pages)`);
  }

  const writer = new NvsWriter(opts.size, version);
  let ns = 0;
  for (const e of entries) {
    switch (e.type) {
      case 'namespace':
        ns = writer.writeNamespace(e.key);
        break;
      case 'u8':
      case 'i8':
      case 'u16':
      case 'i16':
      case 'u32':
      case 'i32':
      case 'u64':
      case 'i64': {
        const num = toBigInt(e.value);
        writer.writePrimitive(e.key, num, e.type, ns);
        break;
      }
      case 'string': {
        const s = typeof e.value === 'string' ? e.value : String(e.value);
        const encoded = utf8Encode(s + '\u0000');
        writer.writeVarlen(e.key, encoded, 'string', ns);
        break;
      }
      case 'binary': {
        const bin = toBinary(e.value, e.encoding ?? 'raw');
        writer.writeVarlen(e.key, bin, 'binary', ns);
        break;
      }
      default:
        throw new InputError(`unsupported NVS entry type ${(e as { type: string }).type}`);
    }
  }
  return writer.finalize();
}

function toBigInt(v: number | bigint | string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  // int(x, 0) style.
  const trimmed = v.trim();
  if (/^-?0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
  if (/^-?0o[0-7]+$/.test(trimmed)) return BigInt(trimmed);
  if (/^-?0b[01]+$/.test(trimmed)) return BigInt(trimmed);
  if (/^-?[0-9]+$/.test(trimmed)) return BigInt(trimmed);
  throw new InputError(`cannot parse integer value '${v}'`);
}

function toBinary(value: Uint8Array | string, encoding: 'raw' | 'hex2bin' | 'base64'): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (encoding === 'hex2bin') return hexDecode(value);
  if (encoding === 'base64') return base64Decode(value);
  return utf8Encode(value);
}

function hexDecode(s: string): Uint8Array {
  const str = s.trim();
  if (str.length % 2 !== 0) throw new InputError('hex2bin value has odd length');
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(str.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new InputError('invalid hex character');
    out[i] = byte;
  }
  return out;
}

function base64Decode(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const binStr = atob(s);
    const out = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i);
    return out;
  }
  // Node fallback.
  return new Uint8Array(Buffer.from(s, 'base64'));
}
