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

/** `DIR_NTRes` for 8.3 names when LFN support is on (ESP-IDF `Entry.LDIR_DIR_NTRES`). */
export const NTRES_LFN_FITS_SHORT = 0x18;

export const FATFS_INCEPTION_YEAR = 1980;

/**
 * Return the FAT type for the number of data clusters, matching FatFs (ff.c)
 * runtime mount logic. Do not include FAT[0] and FAT[1] in this count; those
 * two reserved entries are only added when sizing or indexing the FAT table.
 *
 * FatFs ff.c uses an inclusive waterfall (last match wins):
 *   if (nclst <= MAX_FAT32) fmt = FS_FAT32;
 *   if (nclst <= MAX_FAT16) fmt = FS_FAT16;   // MAX_FAT16 = 0xFFF5 = 65525
 *   if (nclst <= MAX_FAT12) fmt = FS_FAT12;   // MAX_FAT12 = 0xFF5  = 4085
 *
 * Effective boundaries (inclusive), per elm-chan's FAT documentation and ff.c:
 *   FAT12: dataClusters <= 4085
 *   FAT16: 4086 <= dataClusters <= 65525
 *   FAT32: dataClusters >= 65526
 *
 * These boundaries come from elm-chan's own "The basics of FAT filesystem"
 * document (https://elm-chan.org/docs/fat_e.html), which FatFs is written
 * against: "A volume with count of clusters ≦4085 is FAT12."
 *
 * FYI: Microsoft's fatgen103.doc uses '<' with the same numbers (FAT12 < 4085,
 * FAT16 < 65525), making 4085 → FAT16 and 65525 → FAT32. ff.c's comment notes
 * this deviation: "differs from specs [fatgen103], but right for real DOS/Windows
 * behavior." elm-chan's doc also confirms Windows uses 4085 as the FAT12 limit.
 *
 * IDF's Python tools pass (dataClusters + 2) to their equivalent function,
 * shifting boundaries down by 2 and diverging from both ff.c and elm-chan's doc.
 */
export function getFatfsType(dataClustersCount: number): 12 | 16 | 32 {
  if (dataClustersCount <= FAT12_MAX_CLUSTERS) return FAT12;
  if (dataClustersCount <= FAT16_MAX_CLUSTERS) return FAT16;
  return FAT32;
}

/** Number of sectors required to hold the FAT for the given data cluster count. */
export function getFatSectorsCount(dataClustersCount: number, sectorSize: number): number {
  const type = getFatfsType(dataClustersCount);
  return getFatSectorsCountForType(dataClustersCount, sectorSize, type);
}

export function getFatSectorsCountForType(
  dataClustersCount: number,
  sectorSize: number,
  type: 12 | 16 | 32,
): number {
  if (type === FAT32) {
    // FAT[0] and FAT[1] are reserved entries, so the FAT table stores the
    // data clusters plus those two slots.
    const bytes = (dataClustersCount + RESERVED_CLUSTERS_COUNT) * 4;
    return Math.ceil(bytes / sectorSize);
  }
  const clusterS = type / 4; // nibbles
  const bytes =
    type === FAT16
      ? dataClustersCount * 2 + clusterS
      : ((dataClustersCount * 3 + 1) >> 1) + clusterS;
  return Math.ceil(bytes / sectorSize);
}

export function buildDateEntry(year: number, month: number, day: number): number {
  if (year < FATFS_INCEPTION_YEAR || year > FATFS_INCEPTION_YEAR + 127) {
    throw new Error(`year ${year} out of range`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`month ${month} out of range`);
  }
  if (day < 1 || day > 31) {
    throw new Error(`day ${day} out of range`);
  }
  const y = year - FATFS_INCEPTION_YEAR;
  return ((y & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
}

export function buildTimeEntry(hour: number, minute: number, second: number): number {
  if (hour < 0 || hour > 23) {
    throw new Error(`hour ${hour} out of range`);
  }
  if (minute < 0 || minute > 59) {
    throw new Error(`minute ${minute} out of range`);
  }
  if (second < 0 || second > 59) {
    throw new Error(`second ${second} out of range`);
  }
  return ((hour & 0x1f) << 11) | ((minute & 0x3f) << 5) | ((second >> 1) & 0x1f);
}
