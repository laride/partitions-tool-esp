import { type VirtualDirectory } from '../common/virtual-fs.js';
import {
  type LittleFSBuildInput,
  type LittleFSConfig,
  buildConfig,
  lfsCrc32,
  mkTag,
  ctzPointerCount,
  LFS_MAGIC,
  LFS_DISK_VERSION,
  LFS_TYPE_SUPERBLOCK,
  LFS_TYPE_INLINESTRUCT,
  LFS_TYPE_CTZSTRUCT,
  LFS_TYPE_DIRSTRUCT,
  LFS_TYPE_REG,
  LFS_TYPE_DIR,
  LFS_TYPE_HARDTAIL,
  LFS_TYPE_SOFTTAIL,
  LFS_TYPE_CRC,
  writeU32le,
  writeU32be,
} from './constants.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface LittleFSGenerateOptions extends LittleFSBuildInput {
  source: VirtualDirectory;
}

interface MetaEntry {
  type3: number;
  id: number;
  data: Uint8Array;
}

function buildSuperblockEntries(config: LittleFSConfig): MetaEntry[] {
  const sb = new Uint8Array(24);
  writeU32le(sb, 0, LFS_DISK_VERSION);
  writeU32le(sb, 4, config.blockSize);
  writeU32le(sb, 8, config.blockCount);
  writeU32le(sb, 12, config.nameMax);
  writeU32le(sb, 16, config.fileMax);
  writeU32le(sb, 20, config.attrMax);

  return [
    { type3: LFS_TYPE_SUPERBLOCK, id: 0, data: LFS_MAGIC },
    { type3: LFS_TYPE_INLINESTRUCT, id: 0, data: sb },
  ];
}

// ── Block allocator ────────────────────────────────────────────────────────

class BlockAllocator {
  private next: number;
  constructor(
    private readonly blockCount: number,
    startBlock = 2,
  ) {
    this.next = startBlock;
  }

  alloc(): number {
    if (this.next >= this.blockCount) {
      throw new Error('littlefs: no space left on device');
    }
    return this.next++;
  }

  allocPair(): [number, number] {
    return [this.alloc(), this.alloc()];
  }
}

// ── Commit builder ─────────────────────────────────────────────────────────

function buildCommit(
  revisionCount: number,
  entries: MetaEntry[],
  progSize: number,
  blockSize: number,
): Uint8Array {
  const block = new Uint8Array(blockSize).fill(0xff);

  let off = 0;
  // Revision count (4 bytes LE)
  writeU32le(block, off, revisionCount);
  off += 4;

  // CRC accumulates all raw bytes from the revision count onward
  let crc = lfsCrc32(block.subarray(0, 4));
  let prevTag = 0xffffffff;

  for (const entry of entries) {
    const tag = mkTag(entry.type3, entry.id, entry.data.length);
    const storedTag = (tag ^ prevTag) >>> 0;
    writeU32be(block, off, storedTag);
    crc = lfsCrc32(block.subarray(off, off + 4), crc);
    off += 4;

    if (entry.data.length > 0) {
      block.set(entry.data, off);
      crc = lfsCrc32(block.subarray(off, off + entry.data.length), crc);
      off += entry.data.length;
    }
    prevTag = tag;
  }

  // CRC tag: type1=0x5 (LFS_TYPE_CRC)
  // Chunk bit 0 controls the expected valid state for the next commit.
  // For valid tags, bit 31 = 0. After CRC processing, ptag bit 31 = 0.
  // Erased bytes (0xFF) XOR'd with ptag (bit 31 = 0) → decoded bit 31 = 1 → invalid.
  // So chunk bit 0 = 0 ensures erased storage correctly appears invalid.
  const crcPadding = progSize > 1 ? (progSize - ((off + 8) % progSize)) % progSize : 0;
  const crcDataSize = 4 + crcPadding;
  const crcType3 = LFS_TYPE_CRC; // chunk = 0x00
  const crcTag = mkTag(crcType3, 0x3ff, crcDataSize);
  const storedCrcTag = (crcTag ^ prevTag) >>> 0;
  writeU32be(block, off, storedCrcTag);
  crc = lfsCrc32(block.subarray(off, off + 4), crc);
  off += 4;

  // CRC value (4 bytes LE)
  writeU32le(block, off, crc);
  off += 4;
  // Padding (already 0xFF)
  off += crcPadding;

  if (off > blockSize) {
    throw new Error(`littlefs: commit overflows block (${off} bytes in ${blockSize}-byte block)`);
  }

  return block;
}

// ── Metadata pair writer ───────────────────────────────────────────────────

function writeMetaPair(
  image: Uint8Array,
  pair: [number, number],
  revisionCount: number,
  entries: MetaEntry[],
  config: LittleFSConfig,
): void {
  const commit = buildCommit(revisionCount, entries, config.progSize, config.blockSize);
  // Write to the first block of the pair; second block stays erased (0xFF).
  image.set(commit, pair[0] * config.blockSize);
}

// ── CTZ skip-list writer ───────────────────────────────────────────────────

function writeCtzFile(
  image: Uint8Array,
  content: Uint8Array,
  alloc: BlockAllocator,
  blockSize: number,
): { head: number; size: number } {
  const size = content.length;
  const diskBlocks: number[] = [];
  let remaining = size;
  let contentOff = 0;
  let ctzIdx = 0;

  while (remaining > 0) {
    const diskBlock = alloc.alloc();
    diskBlocks.push(diskBlock);

    const nPointers = ctzPointerCount(ctzIdx);
    const capacity = blockSize - 4 * nPointers;
    const base = diskBlock * blockSize;

    // Write skip-list pointers (LE32)
    let ptrOff = 0;
    for (let i = 0; i < nPointers; i++) {
      const target = diskBlocks[ctzIdx - (1 << i)]!;
      writeU32le(image, base + ptrOff, target);
      ptrOff += 4;
    }

    // Write file data
    const toWrite = Math.min(remaining, capacity);
    image.set(content.subarray(contentOff, contentOff + toWrite), base + ptrOff);
    contentOff += toWrite;
    remaining -= toWrite;
    ctzIdx++;
  }

  return { head: diskBlocks[diskBlocks.length - 1]!, size };
}

// ── Directory builder ──────────────────────────────────────────────────────

interface DirEntry {
  name: string;
  isDir: boolean;
  /** For files: file content. */
  content?: Uint8Array;
  /** For directories: metadata pair pointer. */
  dirPair?: [number, number];
}

function buildDirEntries(
  entries: DirEntry[],
  image: Uint8Array,
  alloc: BlockAllocator,
  config: LittleFSConfig,
  isSuperblock: boolean,
): MetaEntry[] {
  const meta: MetaEntry[] = [];
  let nextId = 0;

  if (isSuperblock) {
    // Superblock entry at id 0.
    // Per SPEC: "the name tag must always be the first tag in the metadata pair"
    // so that the magic string "littlefs" resides at offset 8.
    meta.push(...buildSuperblockEntries(config));
    nextId = 1;
  }

  // Sort entries alphabetically (littlefs keeps directory entries sorted)
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of sorted) {
    const id = nextId++;
    const nameBytes = new TextEncoder().encode(entry.name);
    if (nameBytes.length > config.nameMax) {
      throw new Error(`littlefs: file name '${entry.name}' exceeds name_max (${config.nameMax})`);
    }

    if (entry.isDir) {
      // Directory entry
      meta.push({ type3: LFS_TYPE_DIR, id, data: nameBytes });
      // Dir-struct: 8 bytes (two LE32 block pointers)
      const dirStruct = new Uint8Array(8);
      writeU32le(dirStruct, 0, entry.dirPair![0]);
      writeU32le(dirStruct, 4, entry.dirPair![1]);
      meta.push({ type3: LFS_TYPE_DIRSTRUCT, id, data: dirStruct });
    } else {
      // Regular file
      meta.push({ type3: LFS_TYPE_REG, id, data: nameBytes });
      const content = entry.content!;

      if (content.length <= config.inlineMax) {
        meta.push({ type3: LFS_TYPE_INLINESTRUCT, id, data: content });
      } else {
        const ctz = writeCtzFile(image, content, alloc, config.blockSize);
        const ctzData = new Uint8Array(8);
        writeU32le(ctzData, 0, ctz.head);
        writeU32le(ctzData, 4, ctz.size);
        meta.push({ type3: LFS_TYPE_CTZSTRUCT, id, data: ctzData });
      }
    }
  }

  return meta;
}

// ── Recursive directory processing ─────────────────────────────────────────

function processDirectory(
  dir: VirtualDirectory,
  image: Uint8Array,
  alloc: BlockAllocator,
  config: LittleFSConfig,
): [number, number] {
  const pair: [number, number] = alloc.allocPair();

  const dirEntries: DirEntry[] = [];
  for (const child of dir.children) {
    if (child.kind === 'file') {
      dirEntries.push({ name: child.name, isDir: false, content: child.content });
    } else {
      const childPair = processDirectory(child, image, alloc, config);
      dirEntries.push({ name: child.name, isDir: true, dirPair: childPair });
    }
  }

  const { meta } = splitEntries(dirEntries, image, alloc, config, false);
  writeMetaPair(image, pair, 1, meta, config);
  return pair;
}

// ── Metadata pair splitting ────────────────────────────────────────────────

function estimateCommitSize(entries: MetaEntry[], progSize: number): number {
  let size = 4; // revision count
  for (const e of entries) {
    size += 4 + e.data.length; // tag + data
  }
  size += 4 + 4; // CRC tag + CRC value
  const padding = progSize > 1 ? (progSize - (size % progSize)) % progSize : 0;
  return size + padding;
}

function splitEntries(
  entries: DirEntry[],
  image: Uint8Array,
  alloc: BlockAllocator,
  config: LittleFSConfig,
  isSuperblock: boolean,
): { meta: MetaEntry[]; tailPair: [number, number] | null } {
  const meta = buildDirEntries(entries, image, alloc, config, isSuperblock);
  const commitSize = estimateCommitSize(meta, config.progSize);

  if (commitSize <= config.blockSize) {
    return { meta, tailPair: null };
  }

  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (sorted.length <= 1) {
    const name = sorted.length === 1 ? sorted[0]!.name : '(superblock)';
    throw new Error(
      `littlefs: single directory entry '${name}' exceeds metadata block capacity ` +
        `(need ${commitSize} bytes, block size is ${config.blockSize})`,
    );
  }

  const splitPoint = Math.max(1, Math.floor(sorted.length / 2));
  const firstHalf = sorted.slice(0, splitPoint);
  const secondHalf = sorted.slice(splitPoint);

  // Recursively split the tail half (it may still overflow)
  const tailPair: [number, number] = alloc.allocPair();
  const { meta: tailMeta } = splitEntries(secondHalf, image, alloc, config, false);
  writeMetaPair(image, tailPair, 1, tailMeta, config);

  // Build entries for first half + hard-tail pointer
  let firstMeta = buildDirEntries(firstHalf, image, alloc, config, isSuperblock);
  const tailData = new Uint8Array(8);
  writeU32le(tailData, 0, tailPair[0]);
  writeU32le(tailData, 4, tailPair[1]);
  firstMeta.push({ type3: LFS_TYPE_HARDTAIL, id: 0x3ff, data: tailData });

  // The first half + hard-tail may still overflow — need to split again.
  // In that case, re-split with just the firstHalf entries (non-superblock for tail).
  const firstCommitSize = estimateCommitSize(firstMeta, config.progSize);
  if (firstCommitSize > config.blockSize) {
    if (firstHalf.length <= 1) {
      const name = firstHalf.length === 1 ? firstHalf[0]!.name : '(superblock)';
      throw new Error(
        `littlefs: single directory entry '${name}' exceeds metadata block capacity ` +
          `(need ${firstCommitSize} bytes, block size is ${config.blockSize})`,
      );
    }
    // Re-split the first half, chaining the existing tailPair as the final tail.
    // We split firstHalf into two: firstFirst goes into current pair, firstSecond
    // gets a new metadata pair whose hard-tail points to the existing tailPair.
    const sp2 = Math.max(1, Math.floor(firstHalf.length / 2));
    const firstFirst = firstHalf.slice(0, sp2);
    const firstSecond = firstHalf.slice(sp2);

    const midPair: [number, number] = alloc.allocPair();
    const midMeta = buildDirEntries(firstSecond, image, alloc, config, false);
    const midTailData = new Uint8Array(8);
    writeU32le(midTailData, 0, tailPair[0]);
    writeU32le(midTailData, 4, tailPair[1]);
    midMeta.push({ type3: LFS_TYPE_HARDTAIL, id: 0x3ff, data: midTailData });
    writeMetaPair(image, midPair, 1, midMeta, config);

    firstMeta = buildDirEntries(firstFirst, image, alloc, config, isSuperblock);
    const newTailData = new Uint8Array(8);
    writeU32le(newTailData, 0, midPair[0]);
    writeU32le(newTailData, 4, midPair[1]);
    firstMeta.push({ type3: LFS_TYPE_HARDTAIL, id: 0x3ff, data: newTailData });
  }

  return { meta: firstMeta, tailPair };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a littlefs filesystem image from a virtual directory tree.
 *
 * Produces a binary image compatible with littlefs v2 (on-disk version 2.1).
 * The image can be flashed directly to an ESP32 littlefs partition.
 */
export function generate(opts: LittleFSGenerateOptions): Uint8Array {
  const config = buildConfig(opts);
  const image = new Uint8Array(opts.imageSize).fill(0xff);
  const alloc = new BlockAllocator(config.blockCount, 2); // blocks 0,1 reserved for superblock head

  // Collect root-level directory entries
  const rootEntries: DirEntry[] = [];
  for (const child of opts.source.children) {
    if (child.kind === 'file') {
      rootEntries.push({ name: child.name, isDir: false, content: child.content });
    } else {
      const childPair = processDirectory(child, image, alloc, config);
      rootEntries.push({ name: child.name, isDir: true, dirPair: childPair });
    }
  }

  // Build the active root metadata pair.
  const { meta, tailPair } = splitEntries(rootEntries, image, alloc, config, true);
  const superblockHeadPair: [number, number] = [0, 1];

  if (tailPair === null) {
    // Small roots fit directly in [0, 1], which doubles as the root directory.
    writeMetaPair(image, superblockHeadPair, 1, meta, config);
    return image;
  }

  // Large roots live in a separate active root pair, while [0, 1] remains the
  // start of the superblock soft-tail chain.
  const activeRootPair = alloc.allocPair();
  writeMetaPair(image, activeRootPair, 1, meta, config);

  const headMeta = buildSuperblockEntries(config);
  const softTailData = new Uint8Array(8);
  writeU32le(softTailData, 0, activeRootPair[0]);
  writeU32le(softTailData, 4, activeRootPair[1]);
  headMeta.push({ type3: LFS_TYPE_SOFTTAIL, id: 0x3ff, data: softTailData });
  writeMetaPair(image, superblockHeadPair, 1, headMeta, config);

  return image;
}
