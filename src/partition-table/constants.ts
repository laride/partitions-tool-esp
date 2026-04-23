// Aligned with ESP-IDF's components/partition_table/gen_esp32part.py
export const MAX_PARTITION_LENGTH = 0xc00; // 3K of 4K sector reserved for signature
export const PARTITION_TABLE_SIZE = 0x1000;
export const PARTITION_ENTRY_SIZE = 32;

// Magic bytes for a partition definition entry: 0xAA 0x50.
export const PARTITION_MAGIC = new Uint8Array([0xaa, 0x50]);

// MD5 checksum row magic: 0xEB 0xEB + 14x 0xFF, followed by 16-byte MD5 digest.
export const MD5_PARTITION_BEGIN = new Uint8Array([
  0xeb, 0xeb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

export const APP_TYPE = 0x00;
export const DATA_TYPE = 0x01;
export const BOOTLOADER_TYPE = 0x02;
export const PARTITION_TABLE_TYPE = 0x03;

export const TYPES: Record<string, number> = {
  bootloader: BOOTLOADER_TYPE,
  partition_table: PARTITION_TABLE_TYPE,
  app: APP_TYPE,
  data: DATA_TYPE,
};

export const SUBTYPES: Record<number, Record<string, number>> = {
  [BOOTLOADER_TYPE]: {
    primary: 0x00,
    ota: 0x01,
    recovery: 0x02,
  },
  [PARTITION_TABLE_TYPE]: {
    primary: 0x00,
    ota: 0x01,
  },
  [APP_TYPE]: {
    factory: 0x00,
    test: 0x20,
  },
  [DATA_TYPE]: {
    ota: 0x00,
    phy: 0x01,
    nvs: 0x02,
    coredump: 0x03,
    nvs_keys: 0x04,
    efuse: 0x05,
    undefined: 0x06,
    esphttpd: 0x80,
    fat: 0x81,
    spiffs: 0x82,
    littlefs: 0x83,
    tee_ota: 0x90,
  },
};

// App subtypes include 16 OTA slots + 2 TEE OTA slots.
export const MIN_PARTITION_SUBTYPE_APP_OTA = 0x10;
export const NUM_PARTITION_SUBTYPE_APP_OTA = 16;
export const MIN_PARTITION_SUBTYPE_APP_TEE = 0x30;
export const NUM_PARTITION_SUBTYPE_APP_TEE = 2;

for (let i = 0; i < NUM_PARTITION_SUBTYPE_APP_OTA; i++) {
  SUBTYPES[APP_TYPE]![`ota_${i}`] = MIN_PARTITION_SUBTYPE_APP_OTA + i;
}
for (let i = 0; i < NUM_PARTITION_SUBTYPE_APP_TEE; i++) {
  SUBTYPES[APP_TYPE]![`tee_${i}`] = MIN_PARTITION_SUBTYPE_APP_TEE + i;
}

// Partition flags - bit index in the 32-bit flags field.
export const FLAG_BITS = {
  encrypted: 0,
  readonly: 1,
} as const;

// Alignment per type.
export const ALIGNMENT: Record<number, number> = {
  [APP_TYPE]: 0x10000,
  [DATA_TYPE]: 0x1000,
  [BOOTLOADER_TYPE]: 0x1000,
  [PARTITION_TABLE_TYPE]: 0x1000,
};

export const NVS_RW_MIN_PARTITION_SIZE = 0x3000;

export const DEFAULT_OFFSET_PART_TABLE = 0x8000;
export const DEFAULT_FLASH_SIZE = 4 * 1024 * 1024;

export function getAlignmentOffsetForType(ptype: number): number {
  return ALIGNMENT[ptype] ?? ALIGNMENT[DATA_TYPE]!;
}

export function getPtypeName(ptype: number): string | undefined {
  for (const [k, v] of Object.entries(TYPES)) if (v === ptype) return k;
  return undefined;
}

export function getSubtypeName(ptype: number, subtype: number): string | undefined {
  const map = SUBTYPES[ptype];
  if (!map) return undefined;
  for (const [k, v] of Object.entries(map)) if (v === subtype) return k;
  return undefined;
}

/**
 * Parse an integer-ish string: decimal, `0x...` hex, or with `K`/`M` suffix.
 * If `keywords` is provided and the string matches one of them (case-insensitive),
 * returns the mapped integer.
 */
export function parseInteger(v: string, keywords?: Record<string, number>): number {
  const trimmed = v.trim();
  if (trimmed === '') throw new Error('empty integer value');
  const last = trimmed[trimmed.length - 1]!.toLowerCase();
  if (last === 'k' || last === 'm') {
    const mult = last === 'k' ? 1024 : 1024 * 1024;
    return parseInteger(trimmed.slice(0, -1), keywords) * mult;
  }
  // int(v, 0): supports 0x..., 0o..., 0b..., or decimal.
  const m = trimmed.match(/^-?0x[0-9a-fA-F]+$/);
  if (m) return Number.parseInt(trimmed, 16);
  const m2 = trimmed.match(/^-?[0-9]+$/);
  if (m2) return Number.parseInt(trimmed, 10);
  const m3 = trimmed.match(/^-?0b[01]+$/);
  if (m3)
    return Number.parseInt(trimmed.replace(/^-?0b/, ''), 2) * (trimmed.startsWith('-') ? -1 : 1);
  if (keywords && keywords[trimmed.toLowerCase()] !== undefined) {
    return keywords[trimmed.toLowerCase()]!;
  }
  throw new Error(`invalid integer value '${v}'`);
}
