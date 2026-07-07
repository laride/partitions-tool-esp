// littlefs on-disk format constants and utilities
// Based on littlefs SPEC.md (lfs2.1) and lfs.h

import { ValidationError } from '../common/errors.js';

// ── Version ────────────────────────────────────────────────────────────────
export const LFS_DISK_VERSION = 0x00020001;
export const LFS_DISK_VERSION_MAJOR = 0xffff & (LFS_DISK_VERSION >>> 16);
export const LFS_DISK_VERSION_MINOR = 0xffff & LFS_DISK_VERSION;

// ── Limits ─────────────────────────────────────────────────────────────────
export const LFS_NAME_MAX = 255;
export const LFS_FILE_MAX = 2147483647;
export const LFS_ATTR_MAX = 1022;

// ── Special block addresses ────────────────────────────────────────────────
export const LFS_BLOCK_NULL = 0xffffffff;
export const LFS_BLOCK_INLINE = 0xfffffffe;

// ── Type1 categories (3-bit abstract type, bits 30..28 of the tag) ─────────
export const LFS_TYPE_NAME = 0x000;
export const LFS_TYPE_FROM = 0x100;
export const LFS_TYPE_STRUCT = 0x200;
export const LFS_TYPE_USERATTR = 0x300;
export const LFS_TYPE_SPLICE = 0x400;
export const LFS_TYPE_CRC = 0x500;
export const LFS_TYPE_TAIL = 0x600;
export const LFS_TYPE_GLOBALS = 0x700;

// ── File type (name-tag chunk field) ───────────────────────────────────────
export const LFS_TYPE_REG = 0x001;
export const LFS_TYPE_DIR = 0x002;
export const LFS_TYPE_SUPERBLOCK = 0x0ff;

// ── Struct specialisations ─────────────────────────────────────────────────
export const LFS_TYPE_DIRSTRUCT = 0x200;
export const LFS_TYPE_INLINESTRUCT = 0x201;
export const LFS_TYPE_CTZSTRUCT = 0x202;

// ── Splice specialisations ─────────────────────────────────────────────────
export const LFS_TYPE_CREATE = 0x401;
export const LFS_TYPE_DELETE = 0x4ff;

// ── Tail specialisations ───────────────────────────────────────────────────
export const LFS_TYPE_SOFTTAIL = 0x600;
export const LFS_TYPE_HARDTAIL = 0x601;

// ── Global state ───────────────────────────────────────────────────────────
export const LFS_TYPE_MOVESTATE = 0x7ff;

// ── CRC specialisations ───────────────────────────────────────────────────
export const LFS_TYPE_CCRC = 0x500;
export const LFS_TYPE_FCRC = 0x5ff;

// ── Magic string ───────────────────────────────────────────────────────────
export const LFS_MAGIC = new TextEncoder().encode('littlefs');

// ── CRC-32 (same polynomial as zlib, but no final inversion) ───────────────
const CRC_RTABLE = new Uint32Array([
  0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac, 0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c,
  0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c, 0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c,
]);

export function lfsCrc32(data: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 4) ^ CRC_RTABLE[(crc ^ data[i]!) & 0xf]!;
    crc = (crc >>> 4) ^ CRC_RTABLE[(crc ^ (data[i]! >>> 4)) & 0xf]!;
  }
  return crc >>> 0;
}

// ── Tag helpers ────────────────────────────────────────────────────────────

/** Build a 32-bit metadata tag (valid bit = 0). */
export function mkTag(type3: number, id: number, size: number): number {
  return (((type3 & 0x7ff) << 20) | ((id & 0x3ff) << 10) | (size & 0x3ff)) >>> 0;
}

export function tagType3(tag: number): number {
  return (tag >>> 20) & 0x7ff;
}
export function tagType1(tag: number): number {
  return (tag >>> 28) & 0x7;
}
export function tagChunk(tag: number): number {
  return (tag >>> 20) & 0xff;
}
export function tagId(tag: number): number {
  return (tag >>> 10) & 0x3ff;
}
export function tagSize(tag: number): number {
  return tag & 0x3ff;
}
export function tagIsValid(tag: number): boolean {
  return tag !== 0 && (tag & 0x80000000) === 0;
}
export function tagIsDelete(tag: number): boolean {
  return tagSize(tag) === 0x3ff;
}

/** The total on-disk size of a tag entry: 4 (tag) + data length. */
export function tagDsize(tag: number): number {
  return 4 + (tagIsDelete(tag) ? 0 : tagSize(tag));
}

// ── Binary helpers ─────────────────────────────────────────────────────────

export function writeU32le(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

export function readU32le(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

export function writeU32be(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

export function readU32be(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

// ── CTZ skip-list helpers ──────────────────────────────────────────────────

/** Count trailing zeros of a 32-bit integer. Returns 32 for 0. */
export function ctz32(n: number): number {
  if (n === 0) return 32;
  let c = 0;
  n = n >>> 0;
  while ((n & 1) === 0) {
    n >>>= 1;
    c++;
  }
  return c;
}

/** Number of skip-list pointers stored at index `n` (0-based). Block 0 has 0. */
export function ctzPointerCount(n: number): number {
  return n === 0 ? 0 : ctz32(n) + 1;
}

/** Usable data bytes in a CTZ block at index `n`, given `blockSize`. */
export function ctzBlockDataSize(n: number, blockSize: number): number {
  return blockSize - 4 * ctzPointerCount(n);
}

/** Smallest power of 2 ≥ a. */
export function npw2(a: number): number {
  a--;
  a |= a >>> 1;
  a |= a >>> 2;
  a |= a >>> 4;
  a |= a >>> 8;
  a |= a >>> 16;
  return (a + 1) >>> 0;
}

// ── Configuration ──────────────────────────────────────────────────────────

export interface LittleFSConfig {
  blockSize: number;
  blockCount: number;
  readSize: number;
  progSize: number;
  nameMax: number;
  fileMax: number;
  attrMax: number;
  /** Max bytes for inlined files. Defaults to min(cacheSize, attrMax, blockSize/8). */
  inlineMax: number;
  blockCycles: number;
}

export interface LittleFSBuildInput {
  imageSize: number;
  blockSize?: number;
  readSize?: number;
  progSize?: number;
  nameMax?: number;
  fileMax?: number;
  attrMax?: number;
  inlineMax?: number;
  blockCycles?: number;
}

export function buildConfig(input: LittleFSBuildInput): LittleFSConfig {
  const blockSize = input.blockSize ?? 4096;
  const readSize = input.readSize ?? 16;
  const progSize = input.progSize ?? 16;
  const nameMax = input.nameMax ?? LFS_NAME_MAX;
  const fileMax = input.fileMax ?? LFS_FILE_MAX;
  const attrMax = input.attrMax ?? LFS_ATTR_MAX;
  const blockCycles = input.blockCycles ?? 512;

  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new ValidationError(`littlefs block size must be a positive integer, got ${blockSize}`);
  }
  if (!Number.isInteger(readSize) || readSize <= 0) {
    throw new ValidationError(`littlefs read size must be a positive integer, got ${readSize}`);
  }
  if (!Number.isInteger(progSize) || progSize <= 0) {
    throw new ValidationError(`littlefs prog size must be a positive integer, got ${progSize}`);
  }
  if (blockSize % readSize !== 0) {
    throw new ValidationError(
      `littlefs block size ${blockSize} must be a multiple of read size ${readSize}`,
    );
  }
  if (blockSize % progSize !== 0) {
    throw new ValidationError(
      `littlefs block size ${blockSize} must be a multiple of prog size ${progSize}`,
    );
  }
  if (blockSize < 104) {
    throw new ValidationError(`littlefs block size ${blockSize} is too small; minimum is 104`);
  }
  if (!Number.isInteger(nameMax) || nameMax < 0 || nameMax > LFS_ATTR_MAX) {
    throw new ValidationError(`littlefs name_max must be 0..${LFS_ATTR_MAX}, got ${nameMax}`);
  }
  if (!Number.isInteger(fileMax) || fileMax < 0 || fileMax > LFS_FILE_MAX) {
    throw new ValidationError(`littlefs file_max must be 0..${LFS_FILE_MAX}, got ${fileMax}`);
  }
  if (!Number.isInteger(attrMax) || attrMax < 0 || attrMax > LFS_ATTR_MAX) {
    throw new ValidationError(`littlefs attr_max must be 0..${LFS_ATTR_MAX}, got ${attrMax}`);
  }

  if (input.imageSize % blockSize !== 0) {
    throw new ValidationError(
      `littlefs image size ${input.imageSize} must be a multiple of block size ${blockSize}`,
    );
  }
  const blockCount = input.imageSize / blockSize;
  if (blockCount < 2) {
    throw new ValidationError('littlefs requires at least 2 blocks');
  }

  const cacheSize = blockSize;
  const inlineMax = input.inlineMax ?? Math.min(cacheSize, attrMax, Math.floor(blockSize / 8));
  const inlineMaxLimit = Math.min(cacheSize, attrMax, Math.floor(blockSize / 8));
  if (!Number.isInteger(inlineMax) || inlineMax < 0 || inlineMax > inlineMaxLimit) {
    throw new ValidationError(`littlefs inline_max must be 0..${inlineMaxLimit}, got ${inlineMax}`);
  }

  return {
    blockSize,
    blockCount,
    readSize,
    progSize,
    nameMax,
    fileMax,
    attrMax,
    inlineMax,
    blockCycles,
  };
}
