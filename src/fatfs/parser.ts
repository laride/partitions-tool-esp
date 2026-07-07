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
  FAT16,
  FAT32,
  SIGNATURE_WORD,
  getFatfsType,
} from './constants.js';
import { extractLfnChars, lfnChecksum } from './lfn.js';
import { removeWearLeveling, WlMode } from './wear-leveling.js';

export interface FatfsParseOptions extends WarningOptions {
  /**
   * Wear-leveling handling mode:
   *
   * - `undefined`: auto-detect like `fatfsparse.py`
   * - `false`: force plain FATFS parsing
   * - `true`: force WL unwrapping and auto-detect the WL mode
   * - `'perf' | 'safe'`: force a specific WL mode
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
  image = resolveParseImage(image, opts.wearLeveling);
  const boot = requireBootSector(image, warningSink);
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);

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
    activeDirectories: new Set<number>(),
    warnings: warningSink.warnings,
    onWarning: warningSink.onWarning,
  };

  const rootChildren =
    boot.fatType === FAT32
      ? readDirectoryByCluster(ctx, boot.rootClusterId, /*isRoot*/ true)
      : readDirectory(
          image.subarray(rootDirStart, rootDirStart + rootDirBytes),
          ctx,
          /*isRoot*/ true,
        );
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
  activeDirectories: Set<number>;
  warnings: ParseWarning[];
  onWarning?: (warning: ParseWarning) => void;
}

interface ChainReadOptions {
  subject: string;
}

interface LfnChainState {
  chunks: string[];
  checksumExpected: number;
  expectedNextOrder: number | null;
  sawLastEntry: boolean;
  startOffset: number;
}

const NTRES_LOWERCASE_BODY = 0x08;
const NTRES_LOWERCASE_EXT = 0x10;

function resolveParseImage(
  image: Uint8Array,
  wearLeveling: FatfsParseOptions['wearLeveling'],
): Uint8Array {
  if (wearLeveling === false) return image;
  if (wearLeveling === true) {
    return tryUnwrapWearLeveling(image) ?? failWearLeveling();
  }
  if (wearLeveling === 'perf' || wearLeveling === 'safe') {
    return removeWearLeveling(image, wearLeveling);
  }
  const plain = tryReadBootSector(image);
  if (plain && plain.totalSectors * plain.sectorSize === image.length) return image;
  return tryUnwrapWearLeveling(image) ?? image;
}

function failWearLeveling(): never {
  throw new InputError(
    'wear-leveling was forced but the image does not look like a WL-wrapped FATFS',
  );
}

function tryUnwrapWearLeveling(image: Uint8Array): Uint8Array | null {
  try {
    const plain = removeWearLeveling(image); // auto-detects mode and FAT sector size
    const boot = tryReadBootSector(plain);
    if (boot && boot.totalSectors * boot.sectorSize === plain.length) return plain;
  } catch {
    // ignore
  }
  return null;
}

function requireBootSector(
  image: Uint8Array,
  warnings?: Pick<ParseContext, 'warnings' | 'onWarning'>,
): FatfsBootSector {
  if (image.length < 512) throw new InputError('image too small');
  if (image[510] !== SIGNATURE_WORD[0] || image[511] !== SIGNATURE_WORD[1]) {
    throw new InputError('missing 0x55AA boot signature');
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  return readBootSector(view, image, warnings);
}

function tryReadBootSector(image: Uint8Array): FatfsBootSector | null {
  try {
    return requireBootSector(image);
  } catch {
    return null;
  }
}

function resetLfnChain(): LfnChainState {
  return {
    chunks: [],
    checksumExpected: -1,
    expectedNextOrder: null,
    sawLastEntry: false,
    startOffset: -1,
  };
}

function readBootSector(
  view: DataView,
  image: Uint8Array,
  warnings?: Pick<ParseContext, 'warnings' | 'onWarning'>,
): FatfsBootSector {
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
  validateBootSectorFields(
    {
      sectorSize,
      sectorsPerCluster,
      reservedSectorsCount,
      fatTablesCount,
      rootEntryCount,
      fatSectorsCount,
    },
    warnings,
  );

  const rootDirSectors = (rootEntryCount * ENTRY_SIZE) / sectorSize;
  const dataSectors =
    totalSectors - reservedSectorsCount - fatSectorsCount * fatTablesCount - rootDirSectors;
  // FatFs/ESP-IDF runtime selects FAT12/16/32 from data clusters only. FAT[0]
  // and FAT[1] are reserved entries and must not be added for this decision.
  const dataClusters = Math.floor(dataSectors / sectorsPerCluster);

  let fatType: 12 | 16 | 32;
  let rootClusterId = 0;
  let volumeUuid: number;
  let volumeLabel: string;
  let fileSysType: string;
  if (isFat32) {
    const detectedType = getFatfsType(dataClusters);
    if (detectedType !== FAT32) {
      emitWarning(
        warnings,
        formatWarning(
          'FatFS',
          'boot sector',
          `BPB describes a FAT32-style volume but ${dataClusters} data clusters make FatFs classify it as FAT${detectedType}; ESP-IDF/FatFs would reject this layout, parsing with FAT32 fields as a recovery fallback`,
        ),
      );
    }
    fatType = FAT32;
    rootClusterId = view.getUint32(44, true);
    volumeUuid = view.getUint32(67, true);
    volumeLabel = asciiDecode(image.subarray(71, 82)).replace(/\s+$/u, '');
    fileSysType = asciiDecode(image.subarray(82, 90)).replace(/\s+$/u, '');
  } else {
    const detectedType = getFatfsType(dataClusters);
    if (detectedType === FAT32) {
      emitWarning(
        warnings,
        formatWarning(
          'FatFS',
          'boot sector',
          `BPB describes a FAT12/16-style volume but ${dataClusters} data clusters make FatFs classify it as FAT32; ESP-IDF rejects this layout, parsing with FAT16 entry width as a recovery fallback`,
        ),
      );
      fatType = FAT16;
    } else {
      fatType = detectedType;
    }
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

function validateBootSectorFields(
  boot: {
    sectorSize: number;
    sectorsPerCluster: number;
    reservedSectorsCount: number;
    fatTablesCount: number;
    rootEntryCount: number;
    fatSectorsCount: number;
  },
  warnings?: Pick<ParseContext, 'warnings' | 'onWarning'>,
): void {
  const validSectorSizes = [512, 1024, 2048, 4096];
  if (!validSectorSizes.includes(boot.sectorSize)) {
    emitWarning(
      warnings,
      formatWarning(
        'FatFS',
        'boot sector',
        `BPB_BytsPerSec=${boot.sectorSize} is outside FatFs/ESP-IDF's usual set (${validSectorSizes.join(', ')})`,
      ),
    );
  }
  const validSectorsPerCluster = [1, 2, 4, 8, 16, 32, 64, 128];
  if (!validSectorsPerCluster.includes(boot.sectorsPerCluster)) {
    emitWarning(
      warnings,
      formatWarning(
        'FatFS',
        'boot sector',
        `BPB_SecPerClus=${boot.sectorsPerCluster} is not one of FatFs' standard power-of-two values (${validSectorsPerCluster.join(', ')})`,
      ),
    );
  }
  if (boot.reservedSectorsCount === 0) {
    emitWarning(
      warnings,
      formatWarning('FatFS', 'boot sector', 'BPB_RsvdSecCnt is zero; FatFs rejects this volume'),
    );
  }
  if (boot.fatTablesCount !== 1 && boot.fatTablesCount !== 2) {
    emitWarning(
      warnings,
      formatWarning(
        'FatFS',
        'boot sector',
        `BPB_NumFATs=${boot.fatTablesCount} is not accepted by FatFs; expected 1 or 2`,
      ),
    );
  }
  const entriesPerSector = boot.sectorSize / ENTRY_SIZE;
  if (
    Number.isFinite(entriesPerSector) &&
    entriesPerSector > 0 &&
    boot.rootEntryCount % entriesPerSector !== 0
  ) {
    emitWarning(
      warnings,
      formatWarning(
        'FatFS',
        'boot sector',
        `BPB_RootEntCnt=${boot.rootEntryCount} is not sector-aligned for ${boot.sectorSize}-byte sectors`,
      ),
    );
  }
  if (boot.fatSectorsCount === 0) {
    emitWarning(
      warnings,
      formatWarning('FatFS', 'boot sector', 'FAT size is zero; FatFs rejects this volume'),
    );
  }
}

function getFatEntryCount(boot: FatfsBootSector): number {
  const rootDirSectors = (boot.rootEntryCount * ENTRY_SIZE) / boot.sectorSize;
  const dataSectors =
    boot.totalSectors -
    boot.reservedSectorsCount -
    boot.fatSectorsCount * boot.fatTablesCount -
    rootDirSectors;
  const dataClusters = Math.floor(dataSectors / boot.sectorsPerCluster);
  return dataClusters + 2;
}

function isValidClusterId(ctx: ParseContext, clusterId: number): boolean {
  return clusterId >= 2 && clusterId < getFatEntryCount(ctx.boot);
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

function collectChain(ctx: ParseContext, firstCluster: number, opts: ChainReadOptions): Uint8Array {
  const sectorBytes = ctx.boot.sectorSize * ctx.boot.sectorsPerCluster;
  const chunks: Uint8Array[] = [];
  let current = firstCluster;
  const seen = new Set<number>();
  while (current >= 2) {
    if (!isValidClusterId(ctx, current)) {
      emitWarning(
        ctx,
        formatWarning(
          'FatFS',
          opts.subject,
          `cluster chain references out-of-range cluster ${current}; recovered by truncating the chain`,
        ),
      );
      break;
    }
    if (seen.has(current)) throw new InputError(`FAT cluster cycle detected at ${current}`);
    seen.add(current);
    const addr = clusterDataAddress(ctx, current);
    if (addr < 0 || addr + sectorBytes > ctx.image.length) {
      emitWarning(
        ctx,
        formatWarning(
          'FatFS',
          opts.subject,
          `cluster ${current} points outside the image bounds; recovered by truncating the chain`,
        ),
      );
      break;
    }
    chunks.push(ctx.image.subarray(addr, addr + sectorBytes));
    const next = getFatEntry(ctx, current);
    if (next === 0) {
      emitWarning(
        ctx,
        formatWarning(
          'FatFS',
          opts.subject,
          `cluster ${current} terminates on a free FAT entry; recovered by truncating the chain`,
        ),
      );
      break;
    }
    if (isEndOfChain(ctx, next)) break;
    if (!isEndOfChain(ctx, next) && next < 2) {
      emitWarning(
        ctx,
        formatWarning(
          'FatFS',
          opts.subject,
          `cluster ${current} links to invalid cluster ${next}; recovered by truncating the chain`,
        ),
      );
      break;
    }
    current = next;
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

function readDirectoryByCluster(
  ctx: ParseContext,
  clusterId: number,
  isRoot: boolean,
  subject = `directory cluster ${clusterId}`,
): VirtualNode[] {
  if (!isValidClusterId(ctx, clusterId)) {
    emitWarning(
      ctx,
      formatWarning(
        'FatFS',
        subject,
        `directory start cluster ${clusterId} is out of range; recovered as an empty directory`,
      ),
    );
    return [];
  }
  if (ctx.activeDirectories.has(clusterId)) {
    throw new InputError(`directory cycle detected at cluster ${clusterId}`);
  }
  if (ctx.visited.has(clusterId)) {
    throw new InputError(`directory cluster ${clusterId} is referenced more than once`);
  }
  ctx.visited.add(clusterId);
  ctx.activeDirectories.add(clusterId);
  try {
    return readDirectory(collectChain(ctx, clusterId, { subject }), ctx, isRoot);
  } finally {
    ctx.activeDirectories.delete(clusterId);
  }
}

function readDirectory(dirBytes: Uint8Array, ctx: ParseContext, isRoot: boolean): VirtualNode[] {
  const result: VirtualNode[] = [];
  // LFN entries appear physically before the short entry they describe, in
  // reverse logical order (order N with 0x40 flag first, then N-1 ... 1).
  let lfn = resetLfnChain();
  for (let i = 0; i + ENTRY_SIZE <= dirBytes.length; i += ENTRY_SIZE) {
    const first = dirBytes[i]!;
    if (first === 0x00) break; // no further entries
    if (first === 0xe5) {
      // deleted entry invalidates any partial LFN chain
      lfn = resetLfnChain();
      continue;
    }
    const attr = dirBytes[i + 11]!;
    if (isLfnEntry(dirBytes, i, attr)) {
      const ordByte = first;
      const order = ordByte & 0x3f;
      const isLastEntry = (ordByte & 0x40) !== 0;
      const checksum = dirBytes[i + 13]!;
      if (order === 0) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `directory entry offset 0x${i.toString(16)}`,
            'discarded an LFN entry with order 0',
          ),
        );
        lfn = resetLfnChain();
        continue;
      }
      const chunk = extractLfnChars(dirBytes.subarray(i, i + ENTRY_SIZE));
      if (lfn.checksumExpected === -1 || isLastEntry) {
        if (lfn.chunks.length > 0 && !lfn.sawLastEntry) {
          emitWarning(
            ctx,
            formatWarning(
              'FatFS',
              `directory entry offset 0x${lfn.startOffset.toString(16)}`,
              'discarded a preceding LFN chain without a terminal last-entry flag',
            ),
          );
        }
        lfn = resetLfnChain();
        lfn.checksumExpected = checksum;
        lfn.expectedNextOrder = order - 1;
        lfn.sawLastEntry = isLastEntry;
        lfn.startOffset = i;
      }
      if (checksum !== lfn.checksumExpected) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `directory entry offset 0x${i.toString(16)}`,
            'discarded a broken LFN chain',
          ),
        );
        lfn = resetLfnChain();
        lfn.checksumExpected = checksum;
        lfn.expectedNextOrder = isLastEntry ? order - 1 : null;
        lfn.sawLastEntry = isLastEntry;
        lfn.startOffset = i;
      } else if (
        !isLastEntry &&
        lfn.expectedNextOrder !== null &&
        order !== lfn.expectedNextOrder
      ) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `directory entry offset 0x${i.toString(16)}`,
            `LFN chain is non-contiguous (expected order ${lfn.expectedNextOrder}, got ${order})`,
          ),
        );
        lfn.expectedNextOrder = order - 1;
      } else if (isLastEntry && lfn.sawLastEntry && lfn.chunks.length > 0) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `directory entry offset 0x${i.toString(16)}`,
            'LFN chain restarted before reaching its short entry',
          ),
        );
        lfn.expectedNextOrder = order - 1;
      } else if (lfn.expectedNextOrder !== null) {
        lfn.expectedNextOrder = order - 1;
      }
      const idx = order - 1;
      while (lfn.chunks.length <= idx) lfn.chunks.push('');
      if (lfn.chunks[idx]) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `directory entry offset 0x${i.toString(16)}`,
            `LFN chain contains a duplicate chunk for order ${order}`,
          ),
        );
      }
      lfn.chunks[idx] = chunk;
      continue;
    }
    if (attr & ATTR_VOLUME_ID) {
      lfn = resetLfnChain();
      continue;
    }
    const shortRaw = dirBytes.subarray(i, i + 11);
    const shortName = parseShortName(shortRaw, dirBytes[i + 12]!);
    let name = shortName;
    if (lfn.chunks.length > 0 && lfn.checksumExpected === lfnChecksum(shortRaw)) {
      if (!lfn.sawLastEntry) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `short name '${shortName}'`,
            'used an LFN chain that is missing the terminal last-entry flag',
          ),
        );
      }
      if (lfn.expectedNextOrder !== 0) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `short name '${shortName}'`,
            'used an LFN chain with missing or out-of-order entries',
          ),
        );
      }
      name = lfn.chunks.join('');
    } else if (lfn.chunks.length > 0) {
      emitWarning(
        ctx,
        formatWarning(
          'FatFS',
          `short name '${shortName}'`,
          'used because the preceding LFN chain checksum did not match',
        ),
      );
    }
    lfn = resetLfnChain();
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
      const children =
        fstClus >= 2 ? readDirectoryByCluster(ctx, fstClus, false, `directory '${name}'`) : [];
      if (fstClus < 2) {
        emitWarning(
          ctx,
          formatWarning(
            'FatFS',
            `directory '${name}'`,
            `directory entry uses invalid start cluster ${fstClus}; recovered as an empty directory`,
          ),
        );
      }
      result.push({ kind: 'dir', name, children });
    } else {
      let content: Uint8Array;
      if (size === 0 || fstClus < 2) {
        if (size > 0 && fstClus < 2) {
          emitWarning(
            ctx,
            formatWarning(
              'FatFS',
              `file '${name}'`,
              `file has size ${size} but invalid start cluster ${fstClus}; recovered as empty content`,
            ),
          );
        }
        content = new Uint8Array(0);
      } else {
        const raw = collectChain(ctx, fstClus, { subject: `file '${name}'` });
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

function parseShortName(raw: Uint8Array, ntres: number): string {
  const nameBytes = raw.subarray(0, 8);
  const extBytes = raw.subarray(8, 11);
  const name = asciiDecode(nameBytes).replace(/\s+$/u, '');
  const ext = asciiDecode(extBytes).replace(/\s+$/u, '');
  // DOS trick: first byte 0x05 represents 0xE5 in actual name.
  let n = name;
  if (nameBytes[0] === 0x05) n = '\u00e5' + n.slice(1);
  const body = ntresToLowerCase(n, ntres, NTRES_LOWERCASE_BODY);
  const extension = ntresToLowerCase(ext, ntres, NTRES_LOWERCASE_EXT);
  if (extension.length === 0) return body;
  return `${body}.${extension}`;
}

function isLfnEntry(dirBytes: Uint8Array, offset: number, attr: number): boolean {
  return (
    attr === ATTR_LONG_NAME &&
    dirBytes[offset + 12] === 0 &&
    dirBytes[offset + 26] === 0 &&
    dirBytes[offset + 27] === 0
  );
}

function ntresToLowerCase(value: string, ntres: number, mask: number): string {
  if ((ntres & mask) === 0) return value;
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}
