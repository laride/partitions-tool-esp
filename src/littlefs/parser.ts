import { createDir, createFile, type VirtualDirectory } from '../common/virtual-fs.js';
import {
  emitWarning as pushWarning,
  formatWarning,
  type ParseWarning,
} from '../common/diagnostics.js';
import { ParseError } from '../common/errors.js';
import {
  type LittleFSBuildInput,
  type LittleFSConfig,
  buildConfig,
  lfsCrc32,
  tagType1,
  tagType3,
  tagChunk,
  tagId,
  tagSize,
  tagIsValid,
  tagDsize,
  readU32le,
  readU32be,
  ctzPointerCount,
  LFS_TYPE_NAME,
  LFS_TYPE_STRUCT,
  LFS_TYPE_SPLICE,
  LFS_TYPE_TAIL,
  LFS_TYPE_CCRC,
  LFS_TYPE_REG,
  LFS_TYPE_DIR,
  LFS_TYPE_SUPERBLOCK,
  LFS_TYPE_INLINESTRUCT,
  LFS_TYPE_CTZSTRUCT,
  LFS_TYPE_DIRSTRUCT,
  LFS_TYPE_SOFTTAIL,
  LFS_TYPE_HARDTAIL,
  LFS_BLOCK_NULL,
  LFS_DISK_VERSION_MAJOR,
  ctzBlockDataSize,
  LFS_TYPE_GLOBALS,
  LFS_TYPE_MOVESTATE,
  LFS_TYPE_FCRC,
} from './constants.js';

// ── Public types ───────────────────────────────────────────────────────────

export interface LittleFSParsedFile {
  path: string;
  size: number;
  content: Uint8Array;
}

export interface LittleFSParseResult {
  config: LittleFSConfig;
  superblock: LittleFSSuperblock;
  files: LittleFSParsedFile[];
  root: VirtualDirectory;
  warnings: ParseWarning[];
}

export interface LittleFSSuperblock {
  version: number;
  blockSize: number;
  blockCount: number;
  nameMax: number;
  fileMax: number;
  attrMax: number;
}

export interface LittleFSParseOptions extends Omit<LittleFSBuildInput, 'imageSize'> {
  onWarning?: (warning: ParseWarning) => void;
}

// ── Metadata pair reader ───────────────────────────────────────────────────

interface TagEntry {
  type3: number;
  id: number;
  size: number;
  data: Uint8Array;
}

interface MetaPairInfo {
  entries: TagEntry[];
  count: number;
  tail: [number, number];
  tailType: number | null;
}

type MoveStateDelta = Uint8Array;

interface ParseState {
  readonly activeDirectories: Set<string>;
  readonly moveStateXor: MoveStateDelta;
  readonly warnings: ParseWarning[];
  readonly onWarning?: (warning: ParseWarning) => void;
}

const utf8Decoder = new TextDecoder();
const utf8DecoderFatal = new TextDecoder('utf-8', { fatal: true });

function decodeEntryName(data: Uint8Array, state: ParseState, context: string): string {
  let decoded: string;
  try {
    decoded = utf8DecoderFatal.decode(data);
  } catch {
    decoded = utf8Decoder.decode(data);
    pushWarning(
      state,
      formatWarning(
        'LittleFS',
        context,
        'contains invalid UTF-8 bytes and was decoded with replacement characters',
      ),
    );
    return decoded;
  }

  if (data.some((byte) => byte > 0x7f)) {
    pushWarning(
      state,
      formatWarning('LittleFS', context, 'contains non-ASCII bytes and was decoded as UTF-8'),
    );
  }

  return decoded;
}

function hasSuperblockEntry(entries: TagEntry[]): boolean {
  return entries.some((entry) => entry.type3 === LFS_TYPE_SUPERBLOCK && entry.id === 0);
}

function isCommitCrcTag(tag: number): boolean {
  return (tagType3(tag) & ~1) === LFS_TYPE_CCRC;
}

interface ForwardCrcInfo {
  size: number;
  crc: number;
}

function readForwardCrcInfo(data: Uint8Array): ForwardCrcInfo | null {
  if (data.length !== 8) return null;
  return {
    size: readU32le(data, 0),
    crc: readU32le(data, 4),
  };
}

function canFollowCommit(
  image: Uint8Array,
  base: number,
  nextOff: number,
  fcrc: ForwardCrcInfo | null,
  config: LittleFSConfig,
  warningSink?: ParseState,
): boolean {
  if (nextOff >= config.blockSize) return false;

  if (fcrc === null) {
    return true;
  }

  if (fcrc.size === 0 || nextOff + fcrc.size > config.blockSize) {
    pushWarning(
      warningSink,
      formatWarning(
        'LittleFS',
        `metadata block ${base / config.blockSize}`,
        `stopped commit scan because FCRC size ${fcrc.size} is invalid`,
      ),
    );
    return false;
  }

  const actual = lfsCrc32(image.subarray(base + nextOff, base + nextOff + fcrc.size));
  if (actual !== fcrc.crc) {
    pushWarning(
      warningSink,
      formatWarning(
        'LittleFS',
        `metadata block ${base / config.blockSize}`,
        'stopped commit scan because the next commit failed FCRC validation',
      ),
    );
    return false;
  }

  return true;
}

function readMetaPair(
  image: Uint8Array,
  pair: [number, number],
  config: LittleFSConfig,
  warningSink?: ParseState,
): MetaPairInfo {
  // Find the block with the more recent valid revision
  let bestBlock = -1;
  let bestRev = 0;

  for (let i = 0; i < 2; i++) {
    const blockAddr = pair[i]!;
    if (blockAddr >= config.blockCount) continue;
    const base = blockAddr * config.blockSize;
    const rev = readU32le(image, base);
    const result = validateBlock(image, base, rev, config);
    if (result !== null) {
      if (bestBlock < 0 || seqCmp(rev, bestRev) > 0) {
        bestBlock = i;
        bestRev = rev;
      }
    }
  }

  if (bestBlock < 0) {
    throw new ParseError(
      `littlefs: corrupt metadata pair [${pair[0]}, ${pair[1]}] - no valid commits found`,
    );
  }

  const base = pair[bestBlock]! * config.blockSize;
  return parseBlock(image, base, config, warningSink);
}

/** Sequence comparison for revision counts (handles wrap-around). */
function seqCmp(a: number, b: number): number {
  const diff = (a - b) | 0;
  if (diff > 0) return 1;
  if (diff < 0) return -1;
  return 0;
}

/**
 * Validate a metadata block by scanning all commits and checking CRCs.
 * Returns the end offset of the last valid commit, or null if no valid commit.
 */
function validateBlock(
  image: Uint8Array,
  base: number,
  _rev: number,
  config: LittleFSConfig,
): number | null {
  let off = 0;
  let ptag = 0xffffffff;
  let crc = lfsCrc32(image.subarray(base, base + 4)); // revision count
  off = 4;
  let lastValidOff: number | null = null;
  let commitFcrc: ForwardCrcInfo | null = null;

  while (off < config.blockSize) {
    // Read raw tag
    if (off + 4 > config.blockSize) break;
    const rawTag = readU32be(image, base + off);
    crc = lfsCrc32(image.subarray(base + off, base + off + 4), crc);
    const tag = (rawTag ^ ptag) >>> 0;

    if (!tagIsValid(tag)) break;
    if (off + tagDsize(tag) > config.blockSize) break;

    ptag = tag;

    if (isCommitCrcTag(tag)) {
      // CRC entry - verify
      if (tagSize(tag) < 4) break;
      const storedCrc = readU32le(image, base + off + 4);
      if (crc !== storedCrc) break;

      lastValidOff = off + tagDsize(tag);
      if (!canFollowCommit(image, base, lastValidOff, commitFcrc, config)) break;
      // Reset CRC for next commit and flip valid state per chunk bit 0
      ptag ^= ((tagChunk(tag) & 1) << 31) >>> 0;
      ptag = ptag >>> 0;
      crc = 0xffffffff;
      commitFcrc = null;
    } else {
      // CRC the data
      const dataLen = tagSize(tag);
      if (dataLen > 0) {
        crc = lfsCrc32(image.subarray(base + off + 4, base + off + 4 + dataLen), crc);
      }
      if (tagType3(tag) === LFS_TYPE_FCRC) {
        commitFcrc = readForwardCrcInfo(image.subarray(base + off + 4, base + off + 4 + dataLen));
      }
    }
    off += tagDsize(tag);
  }

  return lastValidOff;
}

/** Parse all valid commits in a metadata block and collect entries. */
function parseBlock(
  image: Uint8Array,
  base: number,
  config: LittleFSConfig,
  warningSink?: ParseState,
): MetaPairInfo {
  let off = 4; // skip revision count
  let ptag = 0xffffffff;
  let crc = lfsCrc32(image.subarray(base, base + 4));

  let count = 0;
  let tail: [number, number] = [LFS_BLOCK_NULL, LFS_BLOCK_NULL];
  let tailType: number | null = null;

  // Accumulate entries, later entries supersede earlier ones
  const entriesMap = new Map<string, TagEntry>();

  let tempCount = 0;
  let tempTail: [number, number] = [LFS_BLOCK_NULL, LFS_BLOCK_NULL];
  let tempTailType: number | null = null;
  const tempEntries = new Map<string, TagEntry>();
  let commitFcrc: ForwardCrcInfo | null = null;

  while (off < config.blockSize) {
    if (off + 4 > config.blockSize) break;
    const rawTag = readU32be(image, base + off);
    crc = lfsCrc32(image.subarray(base + off, base + off + 4), crc);
    const tag = (rawTag ^ ptag) >>> 0;

    if (!tagIsValid(tag)) break;
    if (off + tagDsize(tag) > config.blockSize) break;

    ptag = tag;

    if (isCommitCrcTag(tag)) {
      if (tagSize(tag) < 4) break;
      const storedCrc = readU32le(image, base + off + 4);
      if (crc !== storedCrc) break;

      // Commit is valid - incorporate temp state
      count = tempCount;
      tail = [...tempTail] as [number, number];
      tailType = tempTailType;
      for (const [key, entry] of tempEntries) {
        entriesMap.set(key, entry);
      }

      const nextOff = off + tagDsize(tag);
      if (!canFollowCommit(image, base, nextOff, commitFcrc, config, warningSink)) break;

      ptag ^= ((tagChunk(tag) & 1) << 31) >>> 0;
      ptag = ptag >>> 0;
      crc = 0xffffffff;
      commitFcrc = null;
    } else {
      const t3 = tagType3(tag);
      const id = tagId(tag);
      const sz = tagSize(tag);
      // CRC must cover the data bytes too
      if (sz > 0) {
        crc = lfsCrc32(image.subarray(base + off + 4, base + off + 4 + sz), crc);
      }
      const data = sz > 0 ? image.slice(base + off + 4, base + off + 4 + sz) : new Uint8Array(0);

      if (tagType1(tag) === LFS_TYPE_NAME >>> 8) {
        if (id >= tempCount) tempCount = id + 1;
      } else if (tagType1(tag) === LFS_TYPE_SPLICE >>> 8) {
        if (t3 === 0x401) {
          // CREATE
          if (id >= tempCount) tempCount = id + 1;
        } else if (t3 === 0x4ff) {
          // DELETE - shift IDs
          tempCount--;
          // Remove entries for this id and shift higher IDs
          const toRemove: string[] = [];
          const toShift: [string, TagEntry][] = [];
          for (const [key, entry] of tempEntries) {
            if (entry.id === id) {
              toRemove.push(key);
            } else if (entry.id > id) {
              toRemove.push(key);
              toShift.push([key, { ...entry, id: entry.id - 1 }]);
            }
          }
          for (const k of toRemove) tempEntries.delete(k);
          for (const [_k, entry] of toShift) {
            const newKey = `${entry.type3}:${entry.id}`;
            tempEntries.set(newKey, entry);
          }
        }
      } else if (tagType1(tag) === LFS_TYPE_TAIL >>> 8) {
        if (data.length !== 8) {
          throw new ParseError(`littlefs: invalid tail tag size ${data.length}`);
        }
        const nextTailType = t3;
        if (nextTailType !== LFS_TYPE_SOFTTAIL && nextTailType !== LFS_TYPE_HARDTAIL) {
          throw new ParseError(
            `littlefs: unsupported tail tag type 0x${nextTailType.toString(16)}`,
          );
        }
        tempTail = [readU32le(data, 0), readU32le(data, 4)];
        tempTailType = nextTailType;
      } else if (tagType1(tag) === LFS_TYPE_GLOBALS >>> 8) {
        if (t3 !== LFS_TYPE_MOVESTATE) {
          throw new ParseError(`littlefs: unsupported global-state tag type 0x${t3.toString(16)}`);
        }
        if (data.length !== 12) {
          throw new ParseError(`littlefs: invalid move-state tag size ${data.length}`);
        }
      }

      if (t3 === LFS_TYPE_FCRC) {
        const fcrc = readForwardCrcInfo(data);
        if (fcrc === null) {
          throw new ParseError(`littlefs: invalid FCRC tag size ${data.length}`);
        }
        commitFcrc = fcrc;
      }

      const key = `${t3}:${id}`;
      tempEntries.set(key, { type3: t3, id, size: sz, data });
    }
    off += tagDsize(tag);
  }

  const entries = [...entriesMap.values()];
  return { entries, count, tail, tailType };
}

// ── CTZ skip-list reader ───────────────────────────────────────────────────

function assertValidBlock(block: number, config: LittleFSConfig, context: string): void {
  if (!Number.isInteger(block) || block < 0 || block >= config.blockCount) {
    throw new ParseError(
      `littlefs: ${context} points to invalid block ${block} (expected 0..${config.blockCount - 1})`,
    );
  }
}

function assertDataBlock(block: number, config: LittleFSConfig, context: string): void {
  assertValidBlock(block, config, context);
  if (block === 0 || block === 1) {
    throw new ParseError(`littlefs: ${context} points to reserved superblock block ${block}`);
  }
}

function readCtzFile(
  image: Uint8Array,
  head: number,
  fileSize: number,
  config: LittleFSConfig,
): Uint8Array {
  if (fileSize === 0) return new Uint8Array(0);
  if (fileSize < 0 || fileSize > config.fileMax) {
    throw new ParseError(`littlefs: invalid CTZ file size ${fileSize} (max ${config.fileMax})`);
  }

  // First, compute the number of CTZ blocks
  let remaining = fileSize;
  let idx = 0;
  while (remaining > 0) {
    const cap = ctzBlockDataSize(idx, config.blockSize);
    remaining -= Math.min(remaining, cap);
    idx++;
  }
  const totalBlocks = idx;

  // Traverse from head backwards via the immediate predecessor pointer.
  const blockMap = Array.from<number>({ length: totalBlocks });
  blockMap[totalBlocks - 1] = head;
  assertDataBlock(head, config, 'CTZ head');

  for (let i = totalBlocks - 1; i > 0; i--) {
    const current = blockMap[i]!;
    assertDataBlock(current, config, `CTZ block ${i}`);
    const base = current * config.blockSize;
    const prev = readU32le(image, base);
    assertDataBlock(prev, config, `CTZ block ${i} predecessor`);
    blockMap[i - 1] = prev;
  }

  // Read data from each block
  const result = new Uint8Array(fileSize);
  let written = 0;
  remaining = fileSize;
  for (let i = 0; i < totalBlocks && remaining > 0; i++) {
    const block = blockMap[i]!;
    assertDataBlock(block, config, `CTZ data block ${i}`);
    const base = block * config.blockSize;
    const nPointers = ctzPointerCount(i);
    const dataOff = 4 * nPointers;
    const capacity = config.blockSize - dataOff;
    const toRead = Math.min(remaining, capacity);
    result.set(image.subarray(base + dataOff, base + dataOff + toRead), written);
    written += toRead;
    remaining -= toRead;
  }

  return result;
}

// ── Directory tree builder ─────────────────────────────────────────────────

interface DirFileInfo {
  id: number;
  name: string;
  type: number; // LFS_TYPE_REG or LFS_TYPE_DIR
  content?: Uint8Array;
  dirPair?: [number, number];
}

function extractFiles(
  entries: TagEntry[],
  image: Uint8Array,
  config: LittleFSConfig,
  state: ParseState,
): DirFileInfo[] {
  const nameMap = new Map<number, { name: string; type: number }>();
  const structMap = new Map<number, TagEntry>();

  for (const entry of entries) {
    const t1 = (entry.type3 >>> 8) & 0x7;
    if (t1 === LFS_TYPE_NAME >>> 8 && entry.type3 !== LFS_TYPE_SUPERBLOCK >>> 0) {
      const name = decodeEntryName(
        entry.data,
        state,
        `directory entry id ${entry.id} name in metadata tag 0x${entry.type3.toString(16)}`,
      );
      nameMap.set(entry.id, { name, type: entry.type3 & 0xff });
    } else if (t1 === LFS_TYPE_STRUCT >>> 8) {
      structMap.set(entry.id, entry);
    }
  }

  const files: DirFileInfo[] = [];
  for (const [id, info] of nameMap) {
    if (info.type !== LFS_TYPE_REG && info.type !== LFS_TYPE_DIR) {
      pushWarning(
        state,
        formatWarning(
          'LittleFS',
          `entry '${info.name}'`,
          `skipped because file type 0x${info.type.toString(16)} is unsupported`,
        ),
      );
      continue;
    }

    const structEntry = structMap.get(id);
    const fi: DirFileInfo = { id, name: info.name, type: info.type };

    if (info.type === LFS_TYPE_DIR) {
      if (!structEntry || structEntry.type3 !== LFS_TYPE_DIRSTRUCT) {
        throw new ParseError(`littlefs: directory '${info.name}' is missing a dir-struct tag`);
      }
      if (structEntry.data.length !== 8) {
        throw new ParseError(
          `littlefs: directory '${info.name}' has invalid dir-struct size ${structEntry.data.length}`,
        );
      }
      fi.dirPair = [readU32le(structEntry.data, 0), readU32le(structEntry.data, 4)];
      assertDataBlock(fi.dirPair[0], config, `directory '${info.name}' pair[0]`);
      assertDataBlock(fi.dirPair[1], config, `directory '${info.name}' pair[1]`);
    } else if (info.type === LFS_TYPE_REG) {
      if (!structEntry) {
        throw new ParseError(`littlefs: file '${info.name}' is missing a struct tag`);
      }
      if (structEntry.type3 === LFS_TYPE_INLINESTRUCT) {
        fi.content = structEntry.data;
      } else if (structEntry.type3 === LFS_TYPE_CTZSTRUCT) {
        if (structEntry.data.length !== 8) {
          throw new ParseError(
            `littlefs: file '${info.name}' has invalid CTZ struct size ${structEntry.data.length}`,
          );
        }
        const head = readU32le(structEntry.data, 0);
        const size = readU32le(structEntry.data, 4);
        fi.content = readCtzFile(image, head, size, config);
      } else {
        throw new ParseError(
          `littlefs: file '${info.name}' uses unsupported struct type 0x${structEntry.type3.toString(16)}`,
        );
      }
    }
    files.push(fi);
  }

  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function accumulateMoveState(entries: TagEntry[], state: ParseState): void {
  for (const entry of entries) {
    if (entry.type3 !== LFS_TYPE_MOVESTATE) continue;
    for (let i = 0; i < state.moveStateXor.length; i++) {
      state.moveStateXor[i] = (state.moveStateXor[i] ?? 0) ^ (entry.data[i] ?? 0);
    }
  }
}

function assertMoveStateClear(state: ParseState): void {
  for (const value of state.moveStateXor) {
    if (value !== 0) {
      throw new ParseError(
        'littlefs: filesystem has an active move/sync global state; refusing to parse potentially inconsistent data',
      );
    }
  }
}

function readDirectory(
  image: Uint8Array,
  pair: [number, number],
  config: LittleFSConfig,
  prefix: string,
  result: LittleFSParsedFile[],
  parentDir: VirtualDirectory,
  state: ParseState,
): void {
  const directoryKey = `${pair[0]}:${pair[1]}`;
  if (state.activeDirectories.has(directoryKey)) {
    throw new ParseError(
      `littlefs: detected directory cycle at metadata pair [${pair[0]}, ${pair[1]}]`,
    );
  }
  state.activeDirectories.add(directoryKey);
  let currentPair = pair;
  const seenPairs = new Set<string>();

  try {
    while (true) {
      const pairKey = `${currentPair[0]}:${currentPair[1]}`;
      if (seenPairs.has(pairKey)) {
        throw new ParseError(
          `littlefs: detected hard-tail cycle at metadata pair [${currentPair[0]}, ${currentPair[1]}]`,
        );
      }
      seenPairs.add(pairKey);

      const meta = readMetaPair(image, currentPair, config, state);
      accumulateMoveState(meta.entries, state);
      const files = extractFiles(meta.entries, image, config, state);

      for (const fi of files) {
        const fullPath = prefix + fi.name;
        if (fi.type === LFS_TYPE_DIR && fi.dirPair) {
          const subDir = createDir(fi.name);
          parentDir.children.push(subDir);
          readDirectory(image, fi.dirPair, config, fullPath + '/', result, subDir, state);
        } else if (fi.type === LFS_TYPE_REG) {
          const content = fi.content ?? new Uint8Array(0);
          result.push({ path: fullPath, size: content.length, content });
          parentDir.children.push(createFile(fi.name, content));
        }
      }

      // Follow hard-tail to continue directory
      if (
        meta.tailType === LFS_TYPE_HARDTAIL &&
        meta.tail[0] !== LFS_BLOCK_NULL &&
        meta.tail[1] !== LFS_BLOCK_NULL
      ) {
        currentPair = meta.tail;
      } else {
        break;
      }
    }
  } finally {
    state.activeDirectories.delete(directoryKey);
  }
}

// ── Superblock reader ──────────────────────────────────────────────────────

function resolveRootPair(
  image: Uint8Array,
  initialPair: [number, number],
  config: LittleFSConfig,
  warningSink?: ParseState,
): [number, number] {
  let currentPair = initialPair;
  const seen = new Set<string>();

  while (true) {
    const key = `${currentPair[0]}:${currentPair[1]}`;
    if (seen.has(key)) {
      throw new ParseError(
        `littlefs: detected superblock soft-tail cycle at [${key.replace(':', ', ')}]`,
      );
    }
    seen.add(key);

    const meta = readMetaPair(image, currentPair, config, warningSink);
    if (meta.tailType !== LFS_TYPE_SOFTTAIL) {
      return currentPair;
    }

    if (meta.tail[0] === LFS_BLOCK_NULL || meta.tail[1] === LFS_BLOCK_NULL) {
      throw new ParseError('littlefs: superblock soft-tail points to a null metadata pair');
    }

    assertValidBlock(meta.tail[0], config, 'superblock soft-tail');
    assertValidBlock(meta.tail[1], config, 'superblock soft-tail');
    const nextMeta = readMetaPair(image, meta.tail, config, warningSink);
    if (!hasSuperblockEntry(nextMeta.entries)) {
      return currentPair;
    }
    currentPair = meta.tail;
  }
}

function readSuperblock(entries: TagEntry[]): LittleFSSuperblock {
  let magic: Uint8Array | null = null;
  let sbData: Uint8Array | null = null;

  for (const entry of entries) {
    if (entry.type3 === LFS_TYPE_SUPERBLOCK && entry.id === 0) {
      magic = entry.data;
    }
    if (entry.type3 === LFS_TYPE_INLINESTRUCT && entry.id === 0) {
      sbData = entry.data;
    }
  }

  if (!magic || new TextDecoder().decode(magic) !== 'littlefs') {
    throw new ParseError('littlefs: invalid superblock magic');
  }

  if (!sbData || sbData.length < 24) {
    throw new ParseError('littlefs: superblock data too short');
  }

  const version = readU32le(sbData, 0);
  const majorVersion = (version >>> 16) & 0xffff;
  if (majorVersion !== LFS_DISK_VERSION_MAJOR) {
    throw new ParseError(
      `littlefs: unsupported version ${majorVersion}.${version & 0xffff}, expected ${LFS_DISK_VERSION_MAJOR}.x`,
    );
  }

  return {
    version,
    blockSize: readU32le(sbData, 4),
    blockCount: readU32le(sbData, 8),
    nameMax: readU32le(sbData, 12),
    fileMax: readU32le(sbData, 16),
    attrMax: readU32le(sbData, 20),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse a littlefs v2 filesystem image and extract all files.
 *
 * Supports inline files, CTZ skip-list files, nested directories,
 * and multi-commit metadata blocks.
 */
export function parse(image: Uint8Array, opts: LittleFSParseOptions = {}): LittleFSParseResult {
  const state: ParseState = {
    activeDirectories: new Set<string>(),
    moveStateXor: new Uint8Array(12),
    warnings: [],
    onWarning: opts.onWarning,
  };

  // We need blockSize to read the superblock; use the provided value or default 4096
  const blockSize = opts.blockSize ?? 4096;
  const tempConfig = buildConfig({
    imageSize: image.length,
    blockSize,
    readSize: opts.readSize,
    progSize: opts.progSize,
    nameMax: opts.nameMax,
    fileMax: opts.fileMax,
    attrMax: opts.attrMax,
  });

  // Read superblock from root pair [0, 1]
  const rootMeta = readMetaPair(image, [0, 1], tempConfig, state);
  const superblock = readSuperblock(rootMeta.entries);

  // Rebuild config from superblock values
  const config = buildConfig({
    imageSize: image.length,
    blockSize: superblock.blockSize,
    readSize: opts.readSize ?? 16,
    progSize: opts.progSize ?? 16,
    nameMax: superblock.nameMax,
    fileMax: superblock.fileMax,
    attrMax: superblock.attrMax,
  });
  if (config.blockCount < superblock.blockCount) {
    throw new ParseError(
      `littlefs: image too small - superblock claims ${superblock.blockCount} blocks ` +
        `but image only has ${config.blockCount} blocks`,
    );
  }

  const rootPair = resolveRootPair(image, [0, 1], config, state);
  const meta =
    rootPair[0] === 0 && rootPair[1] === 1 && superblock.blockSize === blockSize
      ? rootMeta
      : readMetaPair(image, rootPair, config, state);

  const files: LittleFSParsedFile[] = [];
  const root = createDir('/');
  accumulateMoveState(rootMeta.entries, state);
  if (!(rootPair[0] === 0 && rootPair[1] === 1 && superblock.blockSize === blockSize)) {
    accumulateMoveState(meta.entries, state);
  }
  const dirFiles = extractFiles(meta.entries, image, config, state);

  for (const fi of dirFiles) {
    if (fi.type === LFS_TYPE_DIR && fi.dirPair) {
      const subDir = createDir(fi.name);
      root.children.push(subDir);
      readDirectory(image, fi.dirPair, config, '/' + fi.name + '/', files, subDir, state);
    } else if (fi.type === LFS_TYPE_REG) {
      const content = fi.content ?? new Uint8Array(0);
      files.push({ path: '/' + fi.name, size: content.length, content });
      root.children.push(createFile(fi.name, content));
    }
  }

  // Follow hard-tail from root (if root directory is split)
  if (
    meta.tailType === LFS_TYPE_HARDTAIL &&
    meta.tail[0] !== LFS_BLOCK_NULL &&
    meta.tail[1] !== LFS_BLOCK_NULL
  ) {
    readDirectory(image, meta.tail as [number, number], config, '/', files, root, state);
  }

  assertMoveStateClear(state);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { config, superblock, files, root, warnings: state.warnings };
}
