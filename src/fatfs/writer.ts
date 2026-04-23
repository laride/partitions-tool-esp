import { asciiEncode } from '../common/binary.js';
import { InputError } from '../common/errors.js';
import { flattenFiles, VirtualDirectory, VirtualNode, walk } from '../common/virtual-fs.js';
import { buildLfnEntries, buildShortAlias, needsLfn } from './lfn.js';
import {
  computeWlLayout,
  WearLevelingOptions,
  wrapWearLeveling,
  WL_SECTOR_SIZE,
  WlMode,
} from './wear-leveling.js';
import {
  ATTR_ARCHIVE,
  ATTR_DIRECTORY,
  DEFAULT_FILE_SYS_TYPE,
  DEFAULT_HIDDEN_SECTORS,
  DEFAULT_MEDIA,
  DEFAULT_NUM_HEADS,
  DEFAULT_OEM,
  DEFAULT_ROOT_ENTRIES,
  DEFAULT_SEC_PER_TRACK,
  DEFAULT_VOLUME_LABEL,
  ENTRY_SIZE,
  FAT12,
  FATFS_INCEPTION_YEAR,
  JMP_BOOT,
  MAX_EXT_SIZE,
  MAX_NAME_SIZE,
  PAD_CHAR,
  RESERVED_CLUSTERS_COUNT,
  SECTOR_SIZE_DEFAULT,
  SIGNATURE_WORD,
  buildDateEntry,
  buildTimeEntry,
  FAT32,
  FAT16_MAX_CLUSTERS,
  getFatSectorsCount,
  getFatSectorsCountForType,
  getFatfsType,
} from './constants.js';

export interface FatfsGenerateOptions {
  /** Partition size in bytes. Must be a multiple of the sector size. */
  size: number;
  source: VirtualDirectory;
  sectorSize?: number;
  sectorsPerCluster?: number;
  fatTablesCount?: 1 | 2;
  rootEntryCount?: number;
  oemName?: string;
  volumeLabel?: string;
  fileSysType?: string;
  /** If set, use this 4-byte integer as the volume UUID (BS_VolID). Defaults to 0 for determinism. */
  volumeUuid?: number;
  /**
   * Explicit file-system type override. If omitted, auto-detected from the
   * cluster count like ESP-IDF's fatfsgen (FAT12/FAT16 only). Pass `32` to
   * emit a FAT32 filesystem regardless of cluster count.
   */
  explicitFatType?: 12 | 16 | 32;
  /** Reserved sectors (FAT32 defaults to 32; FAT12/16 use 1). */
  reservedSectorsCount?: number;
  hiddenSectors?: number;
  mediaType?: number;
  /**
   * Enable long-filename (LFN) support. Defaults to true. When disabled, any
   * file/dir name that does not satisfy 8.3 with uppercase characters causes
   * an `InputError` to be thrown.
   */
  longFilenames?: boolean;
  /**
   * When true, match ESP-IDF's `fatfsgen.py --long_name_support` quirks:
   *
   * - uppercase path parts before splitting (`MixedCase.TXT` is treated as
   *   `MIXEDCASE.TXT`, so LFN kicks in because the stem is 9 chars)
   * - store the LFN entries as lowercase UTF-16
   * - encode the `~N` suffix as the raw byte `N` (e.g. 0x01) rather than the
   *   ASCII digit `'1'`
   *
   * Default: true (for cross-tool interop). Set to false to emit
   * standards-compliant LFN output readable by generic FAT tools.
   */
  espIdfCompat?: boolean;
  /**
   * Wrap the generated FATFS image with wear-leveling metadata so it can be
   * mounted by ESP-IDF's `esp_partition_mount` with the `wear_levelling`
   * component. Pass `true` for the default `'perf'` mode, or an object for
   * fine-grained control.
   *
   * When enabled, the effective FATFS area is shrunk to
   * `size - wl_sectors * 4096`; the rest of the partition holds WL metadata
   * (1 dummy sector + 2 state sectors + 1 config sector, plus 2 extra dump
   * sectors in `'safe'` mode). The resulting image is byte-identical to
   * `wl_fatfsgen.py` output when `deviceId` matches.
   */
  wearLeveling?: boolean | (WearLevelingOptions & { enabled?: boolean });
}

interface Layout {
  sectorSize: number;
  sectorsPerCluster: number;
  fatTablesCount: number;
  reservedSectorsCnt: number;
  rootDirSectorsCnt: number;
  sectorsCount: number;
  fatSectorsCount: number;
  fatType: 12 | 16 | 32;
  totalClusters: number;
  dataRegionStart: number;
  /** For FAT12/16 the fixed root directory start (absolute byte offset). Unused on FAT32. */
  rootDirStart: number;
  /** FAT12/16 only; for FAT32 this is 0. */
  rootEntryCount: number;
  /** FAT32 only: first cluster of the root directory (typically 2). */
  rootClusterId: number;
  /** FAT32 only: sector index of the FSInfo sector (typically 1). */
  fsInfoSector: number;
  /** FAT32 only: sector index of the backup boot sector (typically 6). */
  backupBootSector: number;
}

/**
 * Generate a minimal FAT12/FAT16 image containing files from {@link FatfsGenerateOptions.source}.
 *
 * Supports:
 *  - root + nested directories
 *  - short (8.3, uppercase) filenames + optional LFN for long / mixed-case names
 *  - cluster chaining via FAT12 or FAT16
 *  - duplicated FAT tables (default 2)
 *
 * Matches `fatfsgen.py` byte-for-byte when `use_default_datetime=True` is set on
 * the python side and `volumeUuid` matches. Pass `espIdfCompat: true` (the
 * default) when you want LFN output byte-identical to
 * `fatfsgen.py --long_name_support`.
 */
export function generate(opts: FatfsGenerateOptions): Uint8Array {
  const sectorSize = opts.sectorSize ?? SECTOR_SIZE_DEFAULT;
  const sectorsPerCluster = opts.sectorsPerCluster ?? 1;
  const fatTablesCount = opts.fatTablesCount ?? 2;
  if (opts.size % sectorSize !== 0) {
    throw new InputError(`size ${opts.size} must be a multiple of sector size ${sectorSize}`);
  }

  // Resolve wear-leveling options: when enabled, we shrink the FATFS area so
  // the full partition (FATFS + WL metadata) fits in `opts.size`.
  const wlConfig = resolveWearLevelingOption(opts.wearLeveling);
  let partitionSize = opts.size;
  let fatfsSize = opts.size;
  if (wlConfig) {
    if (sectorSize !== WL_SECTOR_SIZE) {
      throw new InputError(
        `wear leveling requires sector size ${WL_SECTOR_SIZE}, got ${sectorSize}`,
      );
    }
    const wlLayout = computeWlLayout(partitionSize, wlConfig.mode ?? 'perf');
    fatfsSize = wlLayout.plainImageSize;
  }
  const sectorsCount = fatfsSize / sectorSize;

  const layout = buildLayout({
    sectorsCount,
    sectorSize,
    sectorsPerCluster,
    fatTablesCount,
    rootEntryCount: opts.rootEntryCount,
    explicitFatType: opts.explicitFatType,
    reservedSectorsCount: opts.reservedSectorsCount,
  });

  // Initialize image. Data region is 0xFF (matches ESP-IDF layout), other
  // regions are zero-filled.
  const image = new Uint8Array(fatfsSize);
  image.fill(0xff, layout.dataRegionStart);

  writeBootSector(image, layout, {
    oem: opts.oemName ?? DEFAULT_OEM,
    volumeLabel: opts.volumeLabel ?? DEFAULT_VOLUME_LABEL,
    fileSysType: opts.fileSysType ?? (layout.fatType === FAT32 ? 'FAT32' : DEFAULT_FILE_SYS_TYPE),
    volumeUuid: opts.volumeUuid ?? 0,
    hiddenSectors: opts.hiddenSectors ?? DEFAULT_HIDDEN_SECTORS,
    mediaType: opts.mediaType ?? DEFAULT_MEDIA,
  });

  if (layout.fatType === FAT32) {
    writeFsInfoSector(image, layout);
    // Backup boot sector: mirror of boot sector + FSInfo.
    const bkOffset = layout.backupBootSector * layout.sectorSize;
    image.copyWithin(bkOffset, 0, 2 * layout.sectorSize);
  }

  initFatTable(image, layout, opts.mediaType ?? DEFAULT_MEDIA);

  const longFilenamesAllowed = opts.longFilenames ?? true;
  const espIdfCompat = opts.espIdfCompat ?? true;
  const treeNeedsLfn = longFilenamesAllowed && treeHasLfnName(opts.source);
  const ctx: WriterContext = {
    image,
    layout,
    nextFreeCluster: layout.fatType === FAT32 ? layout.rootClusterId : 1,
    longFilenames: longFilenamesAllowed,
    lfnActive: treeNeedsLfn,
    espIdfCompat,
  };

  if (layout.fatType === FAT32) {
    // Mark root cluster as EOC and zero its content.
    setFat(layout, image, layout.rootClusterId, 0x0fffffff);
    const addr = clusterDataAddress(layout, layout.rootClusterId);
    image.fill(0, addr, addr + layout.sectorSize * layout.sectorsPerCluster);
    emitDirectory(ctx, opts.source, layout.rootClusterId, 0, true);
  } else {
    emitDirectory(ctx, opts.source, /*firstClusterId*/ 1, /*parentClusterId*/ 0, /*isRoot*/ true);
  }

  // Duplicate FAT table if needed.
  if (fatTablesCount === 2) {
    const fatStart = layout.reservedSectorsCnt * sectorSize;
    const fatBytes = layout.fatSectorsCount * sectorSize;
    image.copyWithin(fatStart + fatBytes, fatStart, fatStart + fatBytes);
  }

  if (wlConfig) {
    return wrapWearLeveling(image, partitionSize, wlConfig);
  }
  return image;
}

function resolveWearLevelingOption(
  opt: FatfsGenerateOptions['wearLeveling'],
): WearLevelingOptions | null {
  if (!opt) return null;
  if (opt === true) return {};
  if ('enabled' in opt && opt.enabled === false) return null;
  const { enabled: _enabled, ...rest } = opt;
  return rest;
}

/** Export for users who want to know the effective plain FATFS size when WL is enabled. */
export function fatfsAreaSize(partitionSize: number, mode: WlMode = 'perf'): number {
  return computeWlLayout(partitionSize, mode).plainImageSize;
}

interface WriterContext {
  image: Uint8Array;
  layout: Layout;
  nextFreeCluster: number;
  /** User preference: may LFN be emitted at all? */
  longFilenames: boolean;
  /** Auto-detected: does any file/dir in the tree actually need LFN? */
  lfnActive: boolean;
  espIdfCompat: boolean;
}

function treeHasLfnName(dir: VirtualDirectory): boolean {
  for (const child of dir.children) {
    if (needsLfn(child.name)) return true;
    if (child.kind === 'dir' && treeHasLfnName(child)) return true;
  }
  return false;
}

function buildLayout(args: {
  sectorsCount: number;
  sectorSize: number;
  sectorsPerCluster: number;
  fatTablesCount: number;
  rootEntryCount?: number;
  explicitFatType?: 12 | 16 | 32;
  reservedSectorsCount?: number;
}): Layout {
  const { sectorsCount, sectorSize, sectorsPerCluster, fatTablesCount, explicitFatType } = args;

  // Decide FAT type first. Auto-detection uses a trial FAT12/16 layout
  // estimate; for FAT32 the user must request it explicitly.
  const trialFatSectors = getFatSectorsCount(sectorsCount, sectorSize);
  const trialRootSectors =
    ((args.rootEntryCount ?? DEFAULT_ROOT_ENTRIES) * ENTRY_SIZE) / sectorSize;
  const trialDataSectors = sectorsCount - 1 - trialFatSectors * fatTablesCount - trialRootSectors;
  const trialClusters = Math.floor(trialDataSectors / sectorsPerCluster) + RESERVED_CLUSTERS_COUNT;
  const autoType = getFatfsType(trialClusters);
  const fatType: 12 | 16 | 32 = explicitFatType ?? (autoType === 32 ? 16 : autoType);

  if (fatType === FAT32)
    return buildFat32Layout({ ...args, reservedSectorsCount: args.reservedSectorsCount });

  const reservedSectorsCnt = args.reservedSectorsCount ?? 1;
  const rootEntryCount = args.rootEntryCount ?? DEFAULT_ROOT_ENTRIES;
  const rootDirSectorsCnt = (rootEntryCount * ENTRY_SIZE) / sectorSize;
  if (!Number.isInteger(rootDirSectorsCnt)) {
    throw new InputError('root entry count * 32 must be a multiple of sector size');
  }
  const fatSectorsCount = getFatSectorsCount(sectorsCount, sectorSize);
  const dataSectors =
    sectorsCount - reservedSectorsCnt - fatSectorsCount * fatTablesCount - rootDirSectorsCnt;
  const totalClusters = Math.floor(dataSectors / sectorsPerCluster) + RESERVED_CLUSTERS_COUNT;
  const dataRegionStart =
    (reservedSectorsCnt + fatSectorsCount * fatTablesCount + rootDirSectorsCnt) * sectorSize;
  const rootDirStart = (reservedSectorsCnt + fatSectorsCount * fatTablesCount) * sectorSize;
  return {
    sectorSize,
    sectorsPerCluster,
    fatTablesCount,
    reservedSectorsCnt,
    rootDirSectorsCnt,
    sectorsCount,
    fatSectorsCount,
    fatType,
    totalClusters,
    dataRegionStart,
    rootDirStart,
    rootEntryCount,
    rootClusterId: 0,
    fsInfoSector: 0,
    backupBootSector: 0,
  };
}

function buildFat32Layout(args: {
  sectorsCount: number;
  sectorSize: number;
  sectorsPerCluster: number;
  fatTablesCount: number;
  reservedSectorsCount?: number;
}): Layout {
  const { sectorsCount, sectorSize, sectorsPerCluster, fatTablesCount } = args;
  const reservedSectorsCnt = args.reservedSectorsCount ?? 32;
  if (reservedSectorsCnt < 7) {
    throw new InputError('FAT32 requires at least 7 reserved sectors (FSInfo + backup)');
  }
  // Iteratively converge on FAT size.
  let fatSectorsCount = 1;
  let totalClusters = 0;
  for (let i = 0; i < 8; i++) {
    const dataSectors = sectorsCount - reservedSectorsCnt - fatSectorsCount * fatTablesCount;
    if (dataSectors <= 0) throw new InputError('FAT32 partition too small for requested layout');
    totalClusters = Math.floor(dataSectors / sectorsPerCluster) + RESERVED_CLUSTERS_COUNT;
    fatSectorsCount = getFatSectorsCountForType(totalClusters, sectorSize, FAT32);
  }
  const dataRegionStart = (reservedSectorsCnt + fatSectorsCount * fatTablesCount) * sectorSize;
  return {
    sectorSize,
    sectorsPerCluster,
    fatTablesCount,
    reservedSectorsCnt,
    rootDirSectorsCnt: 0,
    sectorsCount,
    fatSectorsCount,
    fatType: FAT32,
    totalClusters,
    dataRegionStart,
    rootDirStart: 0,
    rootEntryCount: 0,
    rootClusterId: 2,
    fsInfoSector: 1,
    backupBootSector: 6,
  };
}

// Referenced only by callers; exposed here for testing.
void FAT16_MAX_CLUSTERS;

function writeBootSector(
  image: Uint8Array,
  layout: Layout,
  params: {
    oem: string;
    volumeLabel: string;
    fileSysType: string;
    volumeUuid: number;
    hiddenSectors: number;
    mediaType: number;
  },
): void {
  const view = new DataView(image.buffer);
  image.set(JMP_BOOT, 0);
  writePaddedAscii(image, 3, 8, params.oem, 0x20);
  view.setUint16(11, layout.sectorSize, true);
  image[13] = layout.sectorsPerCluster;
  view.setUint16(14, layout.reservedSectorsCnt, true);
  image[16] = layout.fatTablesCount;
  view.setUint16(17, layout.rootEntryCount, true);
  const totSec = layout.sectorsCount;
  view.setUint16(19, totSec <= 0xffff ? totSec : 0, true);
  image[21] = params.mediaType;
  // For FAT32 BPB_FATSz16 must be 0; the real FAT size lives in BPB_FATSz32.
  view.setUint16(22, layout.fatType === FAT32 ? 0 : layout.fatSectorsCount, true);
  view.setUint16(24, DEFAULT_SEC_PER_TRACK, true);
  view.setUint16(26, DEFAULT_NUM_HEADS, true);
  view.setUint32(28, params.hiddenSectors, true);
  view.setUint32(32, totSec > 0xffff ? totSec : 0, true);

  if (layout.fatType === FAT32) {
    view.setUint32(36, layout.fatSectorsCount, true); // BPB_FATSz32
    view.setUint16(40, 0, true); // BPB_ExtFlags: mirror all
    view.setUint16(42, 0, true); // BPB_FSVer 0.0
    view.setUint32(44, layout.rootClusterId, true); // BPB_RootClus
    view.setUint16(48, layout.fsInfoSector, true); // BPB_FSInfo
    view.setUint16(50, layout.backupBootSector, true); // BPB_BkBootSec
    // 52..63 reserved, already 0
    image[64] = 0x80; // BS_DrvNum
    image[65] = 0; // BS_Reserved1
    image[66] = 0x29; // BS_BootSig
    view.setUint32(67, params.volumeUuid >>> 0, true);
    writePaddedAscii(image, 71, 11, params.volumeLabel, 0x20);
    writePaddedAscii(image, 82, 8, params.fileSysType, 0x20);
  } else {
    image[36] = 0x80;
    image[38] = 0x29;
    view.setUint32(39, params.volumeUuid >>> 0, true);
    writePaddedAscii(image, 43, 11, params.volumeLabel, 0x20);
    writePaddedAscii(image, 54, 8, params.fileSysType, 0x20);
  }
  image.set(SIGNATURE_WORD, 510);
}

function writeFsInfoSector(image: Uint8Array, layout: Layout): void {
  const offset = layout.fsInfoSector * layout.sectorSize;
  const view = new DataView(image.buffer);
  view.setUint32(offset + 0, 0x41615252, true); // FSI_LeadSig
  // 4..483 reserved
  view.setUint32(offset + 484, 0x61417272, true); // FSI_StrucSig
  view.setUint32(offset + 488, 0xffffffff, true); // FSI_Free_Count (unknown)
  view.setUint32(offset + 492, 0xffffffff, true); // FSI_Nxt_Free (unknown)
  // 496..507 reserved
  view.setUint32(offset + 508, 0xaa550000, true); // FSI_TrailSig
}

function writePaddedAscii(
  dst: Uint8Array,
  offset: number,
  width: number,
  value: string,
  pad: number,
): void {
  const bytes = asciiEncode(value.slice(0, width));
  dst.set(bytes, offset);
  for (let i = bytes.length; i < width; i++) dst[offset + i] = pad;
}

function initFatTable(image: Uint8Array, layout: Layout, mediaType: number): void {
  const fatStart = layout.reservedSectorsCnt * layout.sectorSize;
  const { fatType } = layout;
  if (fatType === FAT12) {
    setFat12(image, fatStart, 0, 0xf00 | mediaType);
    setFat12(image, fatStart, 1, 0xfff);
  } else if (fatType === 16) {
    setFat16(image, fatStart, 0, 0xff00 | mediaType);
    setFat16(image, fatStart, 1, 0xffff);
  } else {
    // FAT32: low byte is media, upper bits set to 1.
    setFat32(image, fatStart, 0, (0x0fffff00 | mediaType) >>> 0);
    setFat32(image, fatStart, 1, 0x0fffffff);
  }
}

function setFat12(image: Uint8Array, fatStart: number, clusterId: number, value: number): void {
  const bitOffset = clusterId * 12;
  const byteOffset = fatStart + (bitOffset >>> 3);
  if ((bitOffset & 7) === 0) {
    image[byteOffset] = value & 0xff;
    image[byteOffset + 1] = (image[byteOffset + 1]! & 0xf0) | ((value >> 8) & 0x0f);
  } else {
    image[byteOffset] = (image[byteOffset]! & 0x0f) | ((value << 4) & 0xf0);
    image[byteOffset + 1] = (value >> 4) & 0xff;
  }
}

function setFat16(image: Uint8Array, fatStart: number, clusterId: number, value: number): void {
  const off = fatStart + clusterId * 2;
  image[off] = value & 0xff;
  image[off + 1] = (value >> 8) & 0xff;
}

function setFat32(image: Uint8Array, fatStart: number, clusterId: number, value: number): void {
  // FAT32 uses 32-bit entries but only the low 28 bits are the cluster value;
  // the upper 4 bits must be preserved per MS spec.
  const off = fatStart + clusterId * 4;
  const view = new DataView(image.buffer, image.byteOffset);
  const current = view.getUint32(off, true);
  const merged = (current & 0xf0000000) | (value & 0x0fffffff);
  view.setUint32(off, merged >>> 0, true);
}

function setFat(layout: Layout, image: Uint8Array, clusterId: number, value: number): void {
  const fatStart = layout.reservedSectorsCnt * layout.sectorSize;
  if (layout.fatType === FAT12) setFat12(image, fatStart, clusterId, value & 0xfff);
  else if (layout.fatType === 16) setFat16(image, fatStart, clusterId, value & 0xffff);
  else setFat32(image, fatStart, clusterId, value >>> 0);
}

function clusterDataAddress(layout: Layout, clusterId: number): number {
  if (layout.fatType !== FAT32 && clusterId === 1) return layout.rootDirStart;
  return layout.dataRegionStart + (clusterId - 2) * layout.sectorSize * layout.sectorsPerCluster;
}

function allocateCluster(ctx: WriterContext): number {
  ctx.nextFreeCluster += 1;
  if (ctx.nextFreeCluster >= ctx.layout.totalClusters) {
    throw new InputError('no free cluster available');
  }
  const id = ctx.nextFreeCluster;
  const endMarker =
    ctx.layout.fatType === FAT12 ? 0xfff : ctx.layout.fatType === 16 ? 0xffff : 0x0fffffff;
  setFat(ctx.layout, ctx.image, id, endMarker);
  const addr = clusterDataAddress(ctx.layout, id);
  ctx.image.fill(0, addr, addr + ctx.layout.sectorSize * ctx.layout.sectorsPerCluster);
  return id;
}

function emitDirectory(
  ctx: WriterContext,
  dir: VirtualDirectory,
  firstClusterId: number,
  parentClusterId: number,
  isRoot: boolean,
): void {
  const usesFixedRoot = isRoot && ctx.layout.fatType !== FAT32;
  // Clear the starting cluster/directory region.
  const startAddr = clusterDataAddress(ctx.layout, firstClusterId);
  const firstSize = usesFixedRoot
    ? ctx.layout.rootDirSectorsCnt * ctx.layout.sectorSize
    : ctx.layout.sectorSize * ctx.layout.sectorsPerCluster;
  ctx.image.fill(0, startAddr, startAddr + firstSize);

  let currentClusterId = firstClusterId;
  let entriesPerCluster = usesFixedRoot
    ? ctx.layout.rootEntryCount
    : ctx.layout.sectorSize / ENTRY_SIZE;
  let entryIndexInCluster = 0;
  let entryAbsAddr = startAddr;

  const allocEntrySlot = (): number => {
    if (entryIndexInCluster >= entriesPerCluster) {
      if (usesFixedRoot) throw new InputError('root directory is full');
      const next = allocateCluster(ctx);
      setFat(ctx.layout, ctx.image, currentClusterId, next);
      currentClusterId = next;
      entryIndexInCluster = 0;
      entriesPerCluster = ctx.layout.sectorSize / ENTRY_SIZE;
      entryAbsAddr = clusterDataAddress(ctx.layout, currentClusterId);
    }
    const addr = entryAbsAddr + entryIndexInCluster * ENTRY_SIZE;
    entryIndexInCluster += 1;
    return addr;
  };

  // Seed "." and ".." for non-root dirs (always short entries).
  if (!isRoot) {
    writeEntry(ctx, allocEntrySlot(), {
      name: '.',
      ext: '',
      attr: ATTR_DIRECTORY,
      firstCluster: firstClusterId,
      size: 0,
    });
    // FAT spec: on FAT32, ".." in a subdirectory of the root must read as 0,
    // not the root cluster. FAT12/16 keep our internal root marker (1) to
    // match ESP-IDF's on-disk layout.
    const dotDotCluster =
      ctx.layout.fatType === FAT32 && parentClusterId === ctx.layout.rootClusterId
        ? 0
        : parentClusterId;
    writeEntry(ctx, allocEntrySlot(), {
      name: '..',
      ext: '',
      attr: ATTR_DIRECTORY,
      firstCluster: dotDotCluster,
      size: 0,
    });
  }

  // fatfsgen.py enumerates children via `os.listdir` sorted alphabetically.
  const children = [...dir.children].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const prefixCounts = new Map<string, number>();

  for (const child of children) {
    emitChild(ctx, child, allocEntrySlot, prefixCounts, firstClusterId);
  }

  // Silence unused import warnings (reserved for potential future walk usage).
  void walk;
  void flattenFiles;
}

function emitChild(
  ctx: WriterContext,
  child: VirtualNode,
  allocEntrySlot: () => number,
  prefixCounts: Map<string, number>,
  parentClusterId: number,
): void {
  const requiresLfn = needsLfn(child.name);

  let firstCluster = 0;
  const size = child.kind === 'file' ? child.content.length : 0;
  const attr = child.kind === 'file' ? ATTR_ARCHIVE : ATTR_DIRECTORY;

  if (child.kind === 'dir') {
    firstCluster = allocateCluster(ctx);
  } else if (size > 0) {
    firstCluster = allocateCluster(ctx);
    writeFileContent(ctx, firstCluster, child.content);
  }

  if (requiresLfn) {
    if (!ctx.longFilenames) {
      throw new InputError(
        `name '${child.name}' requires long-filename support but longFilenames is disabled`,
      );
    }
    // ESP-IDF uppercases the path (including the base name) before LFN
    // processing. This is what ends up stored (lowercased again) in the LFN
    // entries and produces the short alias from the uppercase stem.
    const lfnSource = ctx.espIdfCompat ? child.name.toUpperCase() : child.name;
    const alias = buildShortAlias(child.name, prefixCounts, { espIdfCompat: ctx.espIdfCompat });
    const lfnEntries = buildLfnEntries(lfnSource, alias.bytes11, {
      espIdfCompat: ctx.espIdfCompat,
    });
    for (const raw of lfnEntries) {
      ctx.image.set(raw, allocEntrySlot());
    }
    writeEntryRaw(ctx, allocEntrySlot(), {
      short11: alias.bytes11,
      attr,
      firstCluster,
      size,
      ntres: 0x00,
    });
  } else {
    const { name, ext } = splitToShortName(child.name);
    writeEntry(ctx, allocEntrySlot(), {
      name,
      ext,
      attr,
      firstCluster,
      size,
      // `DIR_NTRes=0x18` marks "short-entry coexists with LFN chain" in ESP-IDF.
      ntres: ctx.lfnActive ? 0x18 : 0x00,
    });
  }

  if (child.kind === 'dir') {
    // The subdir's ".." entry points to our first cluster; emit it now that
    // the parent entry has been written.
    emitDirectory(ctx, child, firstCluster, parentClusterId, false);
  }
}

function splitToShortName(filename: string): { name: string; ext: string } {
  const upper = filename.toUpperCase();
  const dot = upper.lastIndexOf('.');
  if (dot < 0) return { name: upper, ext: '' };
  return { name: upper.slice(0, dot), ext: upper.slice(dot + 1) };
}

interface EntryParams {
  name: string;
  ext: string;
  attr: number;
  firstCluster: number;
  size: number;
  /** `DIR_NTRes` byte: 0x00 (classic) or 0x18 (ESP-IDF LFN-enabled fits_short). */
  ntres?: number;
  date?: { year: number; month: number; day: number };
  time?: { hour: number; minute: number; second: number };
}

function writeEntry(ctx: WriterContext, absAddr: number, params: EntryParams): void {
  if (params.name.length > MAX_NAME_SIZE || params.ext.length > MAX_EXT_SIZE) {
    throw new InputError(
      `short name '${params.name}.${params.ext}' exceeds 8.3 limit; enable longFilenames to use LFN`,
    );
  }
  const short11 = new Uint8Array(11).fill(PAD_CHAR);
  short11.set(asciiEncode(params.name), 0);
  short11.set(asciiEncode(params.ext), 8);
  writeEntryRaw(ctx, absAddr, {
    short11,
    attr: params.attr,
    firstCluster: params.firstCluster,
    size: params.size,
    ntres: params.ntres ?? 0,
    date: params.date,
    time: params.time,
  });
}

interface EntryRawParams {
  /** 11-byte raw `DIR_Name` + `DIR_Name_ext`. */
  short11: Uint8Array;
  attr: number;
  firstCluster: number;
  size: number;
  ntres: number;
  date?: { year: number; month: number; day: number };
  time?: { hour: number; minute: number; second: number };
}

function writeEntryRaw(ctx: WriterContext, absAddr: number, params: EntryRawParams): void {
  const { image } = ctx;
  if (params.short11.length !== 11) throw new Error('short11 must be 11 bytes');
  const entry = new Uint8Array(ENTRY_SIZE);
  entry.set(params.short11, 0);
  entry[11] = params.attr;
  entry[12] = params.ntres & 0xff;
  const date = params.date ?? { year: FATFS_INCEPTION_YEAR, month: 1, day: 1 };
  const time = params.time ?? { hour: 0, minute: 0, second: 0 };
  const dateEntry = buildDateEntry(date.year, date.month, date.day);
  const timeEntry = buildTimeEntry(time.hour, time.minute, time.second);
  const view = new DataView(entry.buffer);
  view.setUint16(14, timeEntry, true); // DIR_CrtTime
  view.setUint16(16, dateEntry, true); // DIR_CrtDate
  view.setUint16(18, dateEntry, true); // DIR_LstAccDate (must equal WrtDate)
  // DIR_FstClusHI at offset 20: FAT32 uses upper 16 bits of first cluster,
  // FAT12/16 leave it zero.
  if (ctx.layout.fatType === FAT32) {
    view.setUint16(20, (params.firstCluster >>> 16) & 0xffff, true);
  }
  view.setUint16(22, timeEntry, true); // DIR_WrtTime
  view.setUint16(24, dateEntry, true); // DIR_WrtDate
  view.setUint16(26, params.firstCluster & 0xffff, true);
  view.setUint32(28, params.size >>> 0, true);
  image.set(entry, absAddr);
}

function writeFileContent(ctx: WriterContext, firstClusterId: number, content: Uint8Array): void {
  const sectorSize = ctx.layout.sectorSize * ctx.layout.sectorsPerCluster;
  let offset = 0;
  let currentCluster = firstClusterId;
  while (offset < content.length) {
    const addr = clusterDataAddress(ctx.layout, currentCluster);
    const chunk = content.subarray(offset, offset + sectorSize);
    ctx.image.set(chunk, addr);
    offset += chunk.length;
    if (offset < content.length) {
      const next = allocateCluster(ctx);
      setFat(ctx.layout, ctx.image, currentCluster, next);
      currentCluster = next;
    }
  }
}
