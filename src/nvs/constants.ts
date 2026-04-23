// Aligned with esp_idf_nvs_partition_gen and ESP-IDF components/nvs_flash/src/nvs_types.hpp.
export const PAGE_SIZE = 4096;
export const ENTRY_SIZE = 32;
export const HEADER_SIZE = 32;
export const BITMAP_SIZE = 32;
export const FIRST_ENTRY_OFFSET = 64;
export const ENTRIES_PER_PAGE = 126;

export const CHUNK_ANY = 0xff;

export const PAGE_STATE_ACTIVE = 0xfffffffe;
export const PAGE_STATE_FULL = 0xfffffffc;
export const PAGE_STATE_EMPTY = 0xffffffff;
export const PAGE_STATE_ERASING = 0xfffffff8;
export const PAGE_STATE_CORRUPTED = 0x00000000;

export const VERSION1 = 0xff;
export const VERSION2 = 0xfe;

export const MAX_BLOB_SIZE = {
  [VERSION1]: 1984,
  [VERSION2]: 4000,
} as const;

export const ITEM_TYPE = {
  u8: 0x01,
  i8: 0x11,
  u16: 0x02,
  i16: 0x12,
  u32: 0x04,
  i32: 0x14,
  u64: 0x08,
  i64: 0x18,
  string: 0x21,
  blob: 0x41,
  blob_data: 0x42,
  blob_index: 0x48,
} as const;

export type PrimitiveType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64';
export type VarlenType = 'string' | 'binary';

export const ITEM_TYPE_NAME: Record<number, string> = {
  0x01: 'u8',
  0x11: 'i8',
  0x02: 'u16',
  0x12: 'i16',
  0x04: 'u32',
  0x14: 'i32',
  0x08: 'u64',
  0x18: 'i64',
  0x21: 'string',
  0x41: 'blob',
  0x42: 'blob_data',
  0x48: 'blob_index',
};

export const PAGE_STATE_NAME: Record<number, string> = {
  [PAGE_STATE_EMPTY]: 'Empty',
  [PAGE_STATE_ACTIVE]: 'Active',
  [PAGE_STATE_FULL]: 'Full',
  [PAGE_STATE_ERASING]: 'Erasing',
  [PAGE_STATE_CORRUPTED]: 'Corrupted',
};

export const ENTRY_STATE_NAME: Record<number, string> = {
  0b11: 'Empty',
  0b10: 'Written',
  0b00: 'Erased',
};
