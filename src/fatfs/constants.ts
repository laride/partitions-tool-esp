export const SECTOR_SIZE_DEFAULT = 0x1000;
export const ENTRY_SIZE = 32;
export const MAX_NAME_SIZE = 8;
export const MAX_EXT_SIZE = 3;
export const PAD_CHAR = 0x20;

export const FAT12 = 12;
export const FAT16 = 16;
export const FAT32 = 32;

export const FAT12_MAX_CLUSTERS = 4085;
export const FAT16_MAX_CLUSTERS = 65525;
export const RESERVED_CLUSTERS_COUNT = 2;

export const DEFAULT_OEM = 'MSDOS5.0';
export const DEFAULT_VOLUME_LABEL = 'Espressif';
export const DEFAULT_FILE_SYS_TYPE = 'FAT';
export const DEFAULT_ROOT_ENTRIES = 512;
export const DEFAULT_MEDIA = 0xf8;
export const DEFAULT_NUM_HEADS = 0xff;
export const DEFAULT_SEC_PER_TRACK = 0x3f;
export const DEFAULT_HIDDEN_SECTORS = 0;
export const SIGNATURE_WORD = new Uint8Array([0x55, 0xaa]);
export const JMP_BOOT = new Uint8Array([0xeb, 0xfe, 0x90]);

export const ATTR_READ_ONLY = 0x01;
export const ATTR_HIDDEN = 0x02;
export const ATTR_SYSTEM = 0x04;
export const ATTR_VOLUME_ID = 0x08;
export const ATTR_DIRECTORY = 0x10;
export const ATTR_ARCHIVE = 0x20;
export const ATTR_LONG_NAME = ATTR_READ_ONLY | ATTR_HIDDEN | ATTR_SYSTEM | ATTR_VOLUME_ID;

export const FATFS_INCEPTION_YEAR = 1980;

/** Returns the FAT type for the given cluster count per ESP-IDF fatfs heuristic. */
export function getFatfsType(clustersCount: number): 12 | 16 | 32 {
  if (clustersCount < FAT12_MAX_CLUSTERS) return FAT12;
  if (clustersCount <= FAT16_MAX_CLUSTERS) return FAT16;
  return FAT32;
}

/** Number of sectors required to hold the FAT for the given cluster count. */
export function getFatSectorsCount(clustersCount: number, sectorSize: number): number {
  const type = getFatfsType(clustersCount);
  return getFatSectorsCountForType(clustersCount, sectorSize, type);
}

export function getFatSectorsCountForType(
  clustersCount: number,
  sectorSize: number,
  type: 12 | 16 | 32,
): number {
  if (type === FAT32) {
    // 4 bytes per entry, +2 reserved entries worth already accounted for by
    // reserving slot 0 / 1 in the cluster numbering; +1 extra for safety.
    const bytes = (clustersCount + 2) * 4;
    return Math.ceil(bytes / sectorSize);
  }
  const clusterS = type / 4; // nibbles
  const bytes =
    type === FAT16 ? clustersCount * 2 + clusterS : ((clustersCount * 3 + 1) >> 1) + clusterS;
  return Math.ceil(bytes / sectorSize);
}

export function buildDateEntry(year: number, month: number, day: number): number {
  if (year < FATFS_INCEPTION_YEAR || year > FATFS_INCEPTION_YEAR + 127) {
    throw new Error(`year ${year} out of range`);
  }
  const y = year - FATFS_INCEPTION_YEAR;
  return ((y & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
}

export function buildTimeEntry(hour: number, minute: number, second: number): number {
  return ((hour & 0x1f) << 11) | ((minute & 0x3f) << 5) | ((second >> 1) & 0x1f);
}
