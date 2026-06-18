export const SPIFFS_PH_FLAG_USED_FINAL_INDEX = 0xf8;
export const SPIFFS_PH_FLAG_USED_FINAL = 0xfc;

export const SPIFFS_PH_FLAG_LEN = 1;
export const SPIFFS_PH_IX_SIZE_LEN = 4;
export const SPIFFS_PH_IX_OBJ_TYPE_LEN = 1;
export const SPIFFS_TYPE_FILE = 1;

export const SPIFFS_OBJ_ID_LEN = 2;
export const SPIFFS_SPAN_IX_LEN = 2;
export const SPIFFS_PAGE_IX_LEN = 2;
export const SPIFFS_BLOCK_IX_LEN = 2;

export interface SpiffsBuildConfig {
  pageSize: number;
  blockSize: number;
  objIdLen: number;
  spanIxLen: number;
  packed: boolean;
  aligned: boolean;
  objNameLen: number;
  metaLen: number;
  pageIxLen: number;
  blockIxLen: number;
  endianness: 'little' | 'big';
  useMagic: boolean;
  useMagicLen: boolean;
  alignedObjIxTables: boolean;

  PAGES_PER_BLOCK: number;
  OBJ_LU_PAGES_PER_BLOCK: number;
  OBJ_USABLE_PAGES_PER_BLOCK: number;
  OBJ_LU_PAGES_OBJ_IDS_LIM: number;

  OBJ_DATA_PAGE_HEADER_LEN: number;
  OBJ_DATA_PAGE_HEADER_LEN_ALIGNED: number;
  OBJ_DATA_PAGE_HEADER_LEN_ALIGNED_PAD: number;
  OBJ_DATA_PAGE_CONTENT_LEN: number;

  OBJ_INDEX_PAGES_HEADER_LEN: number;
  OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED: number;
  OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD: number;

  OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM: number;
  OBJ_INDEX_PAGES_OBJ_IDS_LIM: number;

  MAX_OBJ_ID: number;
}

export interface SpiffsBuildInput {
  pageSize?: number; // default 256
  blockSize?: number; // default 4096
  objNameLen?: number; // default 32
  metaLen?: number; // default 4
  useMagic?: boolean; // default true
  useMagicLength?: boolean; // default true
  alignedObjIxTables?: boolean; // default false
  endianness?: 'little' | 'big'; // default 'little'
}

export function buildConfig(input: SpiffsBuildInput = {}): SpiffsBuildConfig {
  const pageSize = input.pageSize ?? 256;
  const blockSize = input.blockSize ?? 4096;
  const objIdLen = SPIFFS_OBJ_ID_LEN;
  const spanIxLen = SPIFFS_SPAN_IX_LEN;
  const pageIxLen = SPIFFS_PAGE_IX_LEN;
  const blockIxLen = SPIFFS_BLOCK_IX_LEN;
  const objNameLen = input.objNameLen ?? 32;
  const metaLen = input.metaLen ?? 4;
  const alignedObjIxTables = input.alignedObjIxTables ?? false;

  if (blockSize % pageSize !== 0) {
    throw new Error(`SPIFFS block size ${blockSize} must be a multiple of page size ${pageSize}`);
  }

  if (pageSize <= 0 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error(`SPIFFS page size ${pageSize} must be a power of two`);
  }

  const PAGES_PER_BLOCK = Math.floor(blockSize / pageSize);
  const OBJ_LU_PAGES_PER_BLOCK = Math.max(1, Math.floor((PAGES_PER_BLOCK * objIdLen) / pageSize));
  const OBJ_USABLE_PAGES_PER_BLOCK = PAGES_PER_BLOCK - OBJ_LU_PAGES_PER_BLOCK;
  const OBJ_LU_PAGES_OBJ_IDS_LIM = Math.floor(pageSize / objIdLen);

  const OBJ_DATA_PAGE_HEADER_LEN = objIdLen + spanIxLen + SPIFFS_PH_FLAG_LEN;
  const pad = 4 - (OBJ_DATA_PAGE_HEADER_LEN % 4 === 0 ? 4 : OBJ_DATA_PAGE_HEADER_LEN % 4);
  const OBJ_DATA_PAGE_HEADER_LEN_ALIGNED = OBJ_DATA_PAGE_HEADER_LEN + pad;
  const OBJ_DATA_PAGE_HEADER_LEN_ALIGNED_PAD = pad;
  const OBJ_DATA_PAGE_CONTENT_LEN = pageSize - OBJ_DATA_PAGE_HEADER_LEN;

  const OBJ_INDEX_PAGES_HEADER_LEN =
    OBJ_DATA_PAGE_HEADER_LEN_ALIGNED +
    SPIFFS_PH_IX_SIZE_LEN +
    SPIFFS_PH_IX_OBJ_TYPE_LEN +
    objNameLen +
    metaLen;

  let OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED: number;
  let OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD: number;
  if (alignedObjIxTables) {
    OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED =
      (OBJ_INDEX_PAGES_HEADER_LEN + pageIxLen - 1) & ~(pageIxLen - 1);
    OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD =
      OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED - OBJ_INDEX_PAGES_HEADER_LEN;
  } else {
    OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED = OBJ_INDEX_PAGES_HEADER_LEN;
    OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD = 0;
  }

  // Mirror ESP-IDF's SPIFFS_OBJ_META_LEN + SPIFFS_OBJ_NAME_LEN + 64 <= PAGE_SIZE guard
  // so impossible geometries are rejected before they produce malformed images.
  if (metaLen + objNameLen + 64 > pageSize) {
    throw new Error(
      `SPIFFS page size ${pageSize} is too small for objNameLen=${objNameLen} and metaLen=${metaLen}`,
    );
  }

  const OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM = Math.floor(
    (pageSize - OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED) / pageIxLen,
  );
  const OBJ_INDEX_PAGES_OBJ_IDS_LIM = Math.floor(
    (pageSize - OBJ_DATA_PAGE_HEADER_LEN_ALIGNED) / pageIxLen,
  );
  const MAX_OBJ_ID = (1 << (objIdLen * 8 - 1)) - 1;

  if (input.useMagic ?? true) {
    const objLookupMaxEntries = PAGES_PER_BLOCK - OBJ_LU_PAGES_PER_BLOCK;
    const usedBytesInLastLuPage = (objLookupMaxEntries % OBJ_LU_PAGES_OBJ_IDS_LIM) * objIdLen;
    if (usedBytesInLastLuPage > pageSize - 2 * objIdLen) {
      throw new Error('no room for SPIFFS magic in lookup pages with current configuration');
    }
  }

  return {
    pageSize,
    blockSize,
    objIdLen,
    spanIxLen,
    packed: true,
    aligned: true,
    objNameLen,
    metaLen,
    pageIxLen,
    blockIxLen,
    endianness: input.endianness ?? 'little',
    useMagic: input.useMagic ?? true,
    useMagicLen: input.useMagicLength ?? true,
    alignedObjIxTables,
    PAGES_PER_BLOCK,
    OBJ_LU_PAGES_PER_BLOCK,
    OBJ_USABLE_PAGES_PER_BLOCK,
    OBJ_LU_PAGES_OBJ_IDS_LIM,
    OBJ_DATA_PAGE_HEADER_LEN,
    OBJ_DATA_PAGE_HEADER_LEN_ALIGNED,
    OBJ_DATA_PAGE_HEADER_LEN_ALIGNED_PAD,
    OBJ_DATA_PAGE_CONTENT_LEN,
    OBJ_INDEX_PAGES_HEADER_LEN,
    OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED,
    OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD,
    OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM,
    OBJ_INDEX_PAGES_OBJ_IDS_LIM,
    MAX_OBJ_ID,
  };
}

/** Log base 2 of a power of two. */
export function log2(n: number): number {
  let v = n;
  let out = 0;
  while (v > 1) {
    v >>>= 1;
    out += 1;
  }
  return out;
}

export function writeUint(
  view: DataView,
  offset: number,
  value: number | bigint,
  len: number,
  endianness: 'little' | 'big',
): void {
  const little = endianness === 'little';
  const max = (1n << BigInt(len * 8)) - 1n;
  let normalized: bigint;

  if (typeof value === 'bigint') {
    normalized = value;
  } else {
    if (!Number.isInteger(value) || !Number.isFinite(value)) {
      throw new Error(`value ${value} is not a finite integer`);
    }
    normalized = BigInt(value);
  }

  if (normalized < 0 || normalized > max) {
    throw new Error(`value ${normalized} does not fit in unsigned ${len}-byte field`);
  }

  switch (len) {
    case 1:
      view.setUint8(offset, Number(normalized));
      return;
    case 2:
      view.setUint16(offset, Number(normalized), little);
      return;
    case 4:
      view.setUint32(offset, Number(normalized), little);
      return;
    case 8:
      view.setBigUint64(offset, normalized, little);
      return;
    default:
      throw new Error(`unsupported width ${len}`);
  }
}

export function readUint(
  view: DataView,
  offset: number,
  len: number,
  endianness: 'little' | 'big',
): number | bigint {
  const little = endianness === 'little';
  switch (len) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset, little);
    case 4:
      return view.getUint32(offset, little);
    case 8:
      return view.getBigUint64(offset, little);
    default:
      throw new Error(`unsupported width ${len}`);
  }
}
