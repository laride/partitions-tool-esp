import { asciiDecode } from '../common/binary.js';
import {
  createWarningSink,
  emitWarning,
  formatWarning,
  type ParseWarning,
  type WarningOptions,
} from '../common/diagnostics.js';
import { InputError } from '../common/errors.js';
import { VirtualDirectory, VirtualFile, VirtualNode } from '../common/virtual-fs.js';
import {
  ATTR_DIRECTORY,
  ATTR_LONG_NAME,
  ATTR_VOLUME_ID,
  ENTRY_SIZE,
  FAT12,
  FAT16,
  FAT32,
  SIGNATURE_WORD,
} from './constants.js';
import { extractLfnChars, lfnChecksum } from './lfn.js';
import { removeWearLeveling, WlMode } from './wear-leveling.js';

export interface FatfsParseOptions extends WarningOptions {
  /**
   * Unwrap a wear-leveling wrapped partition before parsing. When `true`, the
   * default `'perf'` mode is assumed; pass the string directly to select
   * `'safe'` mode.
   */
  wearLeveling?: boolean | WlMode;
}

export interface FatfsBootSector {
  oemName: string;
  sectorSize: number;
  sectorsPerCluster: number;
  reservedSectorsCount: number;
  fatTablesCount: number;
  rootEntryCount: number;
  totalSectors: number;
  mediaType: number;
  fatSectorsCount: number;
  volumeUuid: number;
  volumeLabel: string;
  fileSysType: string;
  fatType: 12 | 16 | 32;
  /** FAT32 only: first cluster of the root directory. */
  rootClusterId: number;
}

export interface FatfsParseResult {
  boot: FatfsBootSector;
  root: VirtualDirectory;
  warnings: ParseWarning[];
}

/**
 * Parse a FAT12/FAT16 image into a {@link VirtualDirectory} tree.
 *
 * Only short 8.3 filenames are returned; any long-filename chain entries are
 * skipped (the short entry that terminates the chain is still used).
 */
export function parse(image: Uint8Array, opts: FatfsParseOptions = {}): FatfsParseResult {
  const warningSink = createWarningSink(opts.onWarning);
  if (opts.wearLeveling) {
    const mode: WlMode = opts.wearLeveling === true ? 'perf' : opts.wearLeveling;
    image = removeWearLeveling(image, mode);
  }
  if (image.length < 512) throw new InputError('image too small');
  if (image[510] !== SIGNATURE_WORD[0] || image[511] !== SIGNATURE_WORD[1]) {
    throw new InputError('missing 0x55AA boot signature');
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const boot = readBootSector(view, image);

  const fatStart = boot.reservedSectorsCount * boot.sectorSize;
  const rootDirStart = fatStart + boot.fatSectorsCount * boot.fatTablesCount * boot.sectorSize;
  const rootDirBytes = boot.rootEntryCount * ENTRY_SIZE;
  const dataRegionStart = boot.fatType === FAT32 ? rootDirStart : rootDirStart + rootDirBytes;

  const ctx: ParseContext = {
    image,
    view,
    boot,
    fatStart,
    dataRegionStart,
    visited: new Set<number>(),
    warnings: warningSink.warnings,
    onWarning: warningSink.onWarning,
  };

  let rootBytes: Uint8Array;
  if (boot.fatType === FAT32) {
    rootBytes = collectChain(ctx, boot.rootClusterId);
  } else {
    rootBytes = image.subarray(rootDirStart, rootDirStart + rootDirBytes);
  }
  const rootChildren = readDirectory(ctx, rootBytes, /*isRoot*/ true);
  return {
    boot,
    root: { kind: 'dir', name: '', children: rootChildren },
    warnings: warningSink.warnings,
  };
}

interface ParseContext {
  image: Uint8Array;
  view: DataView;
  boot: FatfsBootSector;
  fatStart: number;
  dataRegionStart: number;
  visited: Set<number>;
  warnings: ParseWarning[];
  onWarning?: (warning: ParseWarning) => void;
}

function readBootSector(view: DataView, image: Uint8Array): FatfsBootSector {
  const oemName = asciiDecode(image.subarray(3, 11)).replace(/\s+$/u, '');
  const sectorSize = view.getUint16(11, true);
  const sectorsPerCluster = image[13]!;
  const reservedSectorsCount = view.getUint16(14, true);
  const fatTablesCount = image[16]!;
  const rootEntryCount = view.getUint16(17, true);
  const totSec16 = view.getUint16(19, true);
  const mediaType = image[21]!;
  const fatSectorsCount16 = view.getUint16(22, true);
  const totSec32 = view.getUint32(32, true);
  const totalSectors = totSec16 !== 0 ? totSec16 : totSec32;
  const isFat32 = fatSectorsCount16 === 0 && rootEntryCount === 0;
  const fatSectorsCount = isFat32 ? view.getUint32(36, true) : fatSectorsCount16;

  const rootDirSectors = (rootEntryCount * ENTRY_SIZE) / sectorSize;
  const dataSectors =
    totalSectors - reservedSectorsCount - fatSectorsCount * fatTablesCount - rootDirSectors;
  const totalClusters = Math.floor(dataSectors / sectorsPerCluster) + 2;

  let fatType: 12 | 16 | 32;
  let rootClusterId = 0;
  let volumeUuid: number;
  let volumeLabel: string;
  let fileSysType: string;
  if (isFat32) {
    fatType = FAT32;
    rootClusterId = view.getUint32(44, true);
    volumeUuid = view.getUint32(67, true);
    volumeLabel = asciiDecode(image.subarray(71, 82)).replace(/\s+$/u, '');
    fileSysType = asciiDecode(image.subarray(82, 90)).replace(/\s+$/u, '');
  } else {
    fatType = totalClusters < 4085 ? FAT12 : FAT16;
    volumeUuid = view.getUint32(39, true);
    volumeLabel = asciiDecode(image.subarray(43, 54)).replace(/\s+$/u, '');
    fileSysType = asciiDecode(image.subarray(54, 62)).replace(/\s+$/u, '');
  }

  return {
    oemName,
    sectorSize,
    sectorsPerCluster,
    reservedSectorsCount,
    fatTablesCount,
    rootEntryCount,
    totalSectors,
    mediaType,
    fatSectorsCount,
    volumeUuid,
    volumeLabel,
    fileSysType,
    fatType,
    rootClusterId,
  };
}

function getFatEntry(ctx: ParseContext, clusterId: number): number {
  if (ctx.boot.fatType === FAT32) {
    return ctx.view.getUint32(ctx.fatStart + clusterId * 4, true) & 0x0fffffff;
  }
  if (ctx.boot.fatType === FAT16) {
    return ctx.view.getUint16(ctx.fatStart + clusterId * 2, true);
  }
  // FAT12: 12-bit entry.
  const bitOffset = clusterId * 12;
  const byteOffset = ctx.fatStart + (bitOffset >>> 3);
  const lo = ctx.image[byteOffset]!;
  const hi = ctx.image[byteOffset + 1]!;
  if ((bitOffset & 7) === 0) return ((hi & 0x0f) << 8) | lo;
  return (hi << 4) | ((lo & 0xf0) >> 4);
}

function isEndOfChain(ctx: ParseContext, value: number): boolean {
  if (ctx.boot.fatType === FAT32) return value >= 0x0ffffff8;
  if (ctx.boot.fatType === FAT16) return value >= 0xfff8;
  return value >= 0xff8;
}

function clusterDataAddress(ctx: ParseContext, clusterId: number): number {
  return ctx.dataRegionStart + (clusterId - 2) * ctx.boot.sectorSize * ctx.boot.sectorsPerCluster;
}

function collectChain(ctx: ParseContext, firstCluster: number): Uint8Array {
  const sectorBytes = ctx.boot.sectorSize * ctx.boot.sectorsPerCluster;
  const chunks: Uint8Array[] = [];
  let current = firstCluster;
  const seen = new Set<number>();
  while (current >= 2 && !isEndOfChain(ctx, current)) {
    if (seen.has(current)) throw new InputError(`FAT cluster cycle detected at ${current}`);
    seen.add(current);
    const addr = clusterDataAddress(ctx, current);
    chunks.push(ctx.image.subarray(addr, addr + sectorBytes));
    current = getFatEntry(ctx, current);
  }
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function readDirectory(ctx: ParseContext, dirBytes: Uint8Array, isRoot: boolean): VirtualNode[] {
  const result: VirtualNode[] = [];
  // LFN entries appear physically before the short entry they describe, in
  // reverse logical order (order N with 0x40 flag first, then N-1 ... 1).
  let lfnBuf: string[] = [];
  let lfnChecksumExpected = -1;
  for (let i = 0; i + ENTRY_SIZE <= dirBytes.length; i += ENTRY_SIZE) {
    const first = dirBytes[i]!;
    if (first === 0x00) break; // no further entries
    if (first === 0xe5) {
      // deleted entry invalidates any partial LFN chain
      lfnBuf = [];
      lfnChecksumExpected = -1;
      continue;
    }
    const attr = dirBytes[i + 11]!;
    if ((attr & ATTR_LONG_NAME) === ATTR_LONG_NAME) {
      // LFN entry: accumulate its 13 chars. Order is 1-based; higher orders
      // come first physically, so we PREPEND to the logical buffer.
      const ordByte = first;
      const order = ordByte & 0x3f;
      const checksum = dirBytes[i + 13]!;
      const chunk = extractLfnChars(dirBytes.subarray(i, i + ENTRY_SIZE));
      if (lfnChecksumExpected === -1 || ordByte & 0x40) {
        lfnBuf = [];
        lfnChecksumExpected = checksum;
      }
      if (checksum !== lfnChecksumExpected) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `directory entry offset 0x${i.toString(16)}`,
            'discarded a broken LFN chain',
          ),
        );
        lfnBuf = [];
        lfnChecksumExpected = checksum;
      }
      // Logical index (0-based) for this chunk:
      const idx = order - 1;
      while (lfnBuf.length <= idx) lfnBuf.push('');
      lfnBuf[idx] = chunk;
      continue;
    }
    if (attr & ATTR_VOLUME_ID) {
      lfnBuf = [];
      lfnChecksumExpected = -1;
      continue;
    }
    const shortRaw = dirBytes.subarray(i, i + 11);
    const shortName = parseShortName(shortRaw);
    let name = shortName;
    if (lfnBuf.length > 0 && lfnChecksumExpected === lfnChecksum(shortRaw)) {
      name = lfnBuf.join('');
    } else if (lfnBuf.length > 0) {
      emitWarning(
        ctx,
        formatWarning(
          'FatFS',
          `short name '${shortName}'`,
          'used because the preceding LFN chain checksum did not match',
        ),
      );
    }
    lfnBuf = [];
    lfnChecksumExpected = -1;
    if (name === '.' || name === '..') continue;
    const fstClusLo = dirBytes[i + 26]! | (dirBytes[i + 27]! << 8);
    const fstClusHi = ctx.boot.fatType === FAT32 ? dirBytes[i + 20]! | (dirBytes[i + 21]! << 8) : 0;
    const fstClus = (fstClusHi << 16) | fstClusLo;
    const size =
      dirBytes[i + 28]! |
      (dirBytes[i + 29]! << 8) |
      (dirBytes[i + 30]! << 16) |
      (dirBytes[i + 31]! << 24);
    if (attr & ATTR_DIRECTORY) {
      const subBytes = fstClus >= 2 ? collectChain(ctx, fstClus) : new Uint8Array(0);
      const children = readDirectory(ctx, subBytes, false);
      result.push({ kind: 'dir', name, children });
    } else {
      let content: Uint8Array;
      if (size === 0 || fstClus < 2) {
        content = new Uint8Array(0);
      } else {
        const raw = collectChain(ctx, fstClus);
        content = raw.subarray(0, size >>> 0);
      }
      const file: VirtualFile = { kind: 'file', name, content };
      result.push(file);
    }
  }
  void isRoot;
  return result;
}

/** Flatten a parsed FatFS tree into a list of `{ path, content }` entries. */
export function flatten(root: VirtualDirectory): Array<{ path: string; content: Uint8Array }> {
  const out: Array<{ path: string; content: Uint8Array }> = [];
  const recurse = (dir: VirtualDirectory, prefix: string): void => {
    for (const child of dir.children) {
      const p = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.kind === 'file') out.push({ path: p, content: child.content });
      else recurse(child, p);
    }
  };
  recurse(root, '');
  return out;
}

function parseShortName(raw: Uint8Array): string {
  const nameBytes = raw.subarray(0, 8);
  const extBytes = raw.subarray(8, 11);
  const name = asciiDecode(nameBytes).replace(/\s+$/u, '');
  const ext = asciiDecode(extBytes).replace(/\s+$/u, '');
  // DOS trick: first byte 0x05 represents 0xE5 in actual name.
  let n = name;
  if (nameBytes[0] === 0x05) n = '\u00e5' + n.slice(1);
  if (ext.length === 0) return n;
  return `${n}.${ext}`;
}
