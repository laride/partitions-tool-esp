import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { ParseError } from '../src/common/errors.js';
import { createDir, createFile, type VirtualNode } from '../src/common/virtual-fs.js';
import { generate, parse } from '../src/littlefs/index.js';
import {
  lfsCrc32,
  LFS_TYPE_CCRC,
  LFS_TYPE_FCRC,
  LFS_TYPE_INLINESTRUCT,
  LFS_TYPE_MOVESTATE,
  mkTag,
  readU32be,
  tagDsize,
  tagIsValid,
  tagType3,
  writeU32be,
  writeU32le,
} from '../src/littlefs/constants.js';

const FIXTURES = resolve(__dirname, 'fixtures');
const fixture = (name: string) => resolve(FIXTURES, name);
const hasFixture = (name: string) => existsSync(fixture(name));
const loadFixture = (name: string) => new Uint8Array(readFileSync(fixture(name)));

const VERIFY_SCRIPT = resolve(__dirname, '..', 'scripts', 'verify-littlefs.py');

interface VerifyFile {
  path: string;
  size: number;
  hex: string;
}
interface VerifyResult {
  superblock: { blockSize: number; blockCount: number };
  files: VerifyFile[];
  error?: string;
}

/**
 * Detect whether python3 + littlefs-python is available.
 * Cached after the first call.
 */
let _pythonAvailable: boolean | undefined;
function hasPythonLittlefs(): boolean {
  if (_pythonAvailable !== undefined) return _pythonAvailable;
  try {
    execFileSync('python3', ['-c', 'import littlefs'], { timeout: 5000, stdio: 'pipe' });
    _pythonAvailable = true;
  } catch {
    _pythonAvailable = false;
  }
  return _pythonAvailable;
}

/**
 * Write image to a temp file, call verify-littlefs.py, return parsed JSON.
 */
function verifyWithPython(image: Uint8Array, blockSize = 4096): VerifyResult {
  const tmp = mkdtempSync(join(tmpdir(), 'lfs-verify-'));
  const binPath = join(tmp, 'image.bin');
  try {
    writeFileSync(binPath, image);
    const stdout = execFileSync(
      'python3',
      [VERIFY_SCRIPT, binPath, '--block-size', String(blockSize)],
      { timeout: 10000, encoding: 'utf-8' },
    );
    return JSON.parse(stdout) as VerifyResult;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function findAsciiOffset(haystack: Uint8Array, text: string): number {
  const needle = new TextEncoder().encode(text);
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  throw new Error(`did not find '${text}' in image`);
}

function readU32leAt(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

function writeU32leAt(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function rewriteFirstCommitCrc(block: Uint8Array, blockSize: number): void {
  let off = 4;
  let ptag = 0xffffffff;
  let crc = lfsCrc32(block.subarray(0, 4));

  while (off < blockSize) {
    const rawTag = readU32be(block, off);
    crc = lfsCrc32(block.subarray(off, off + 4), crc);
    const tag = (rawTag ^ ptag) >>> 0;
    if (!tagIsValid(tag)) {
      throw new Error('failed to locate commit CRC tag');
    }
    ptag = tag;

    const size = tagDsize(tag);
    if ((tagType3(tag) & ~1) === LFS_TYPE_CCRC) {
      writeU32le(block, off + 4, crc);
      return;
    }

    const dataLen = size - 4;
    if (dataLen > 0) {
      crc = lfsCrc32(block.subarray(off + 4, off + 4 + dataLen), crc);
    }
    off += size;
  }

  throw new Error('failed to locate commit CRC tag');
}

function rewriteFirstCommitTags(
  block: Uint8Array,
  blockSize: number,
  transform: (tag: number, data: Uint8Array) => number,
): void {
  const entries: Array<{ off: number; tag: number; data: Uint8Array }> = [];
  let off = 4;
  let ptag = 0xffffffff;

  while (off < blockSize) {
    const rawTag = readU32be(block, off);
    const tag = (rawTag ^ ptag) >>> 0;
    if (!tagIsValid(tag)) {
      throw new Error('failed to decode first commit');
    }

    const size = tagDsize(tag);
    const dataLen = size - 4;
    const data = block.slice(off + 4, off + 4 + dataLen);
    entries.push({ off, tag, data });
    ptag = tag;
    off += size;

    if ((tagType3(tag) & ~1) === LFS_TYPE_CCRC) {
      break;
    }
  }

  let prevTag = 0xffffffff;
  for (const entry of entries) {
    const nextTag = transform(entry.tag, entry.data);
    writeU32be(block, entry.off, (nextTag ^ prevTag) >>> 0);
    prevTag = nextTag;
  }

  rewriteFirstCommitCrc(block, blockSize);
}

function appendInlineCommitWithFcrc(
  image: Uint8Array,
  opts: {
    blockSize?: number;
    progSize?: number;
    fileId: number;
    content: Uint8Array;
    includeFcrc?: boolean;
    fcrcCrc?: number;
  },
): void {
  const blockSize = opts.blockSize ?? 4096;
  const progSize = opts.progSize ?? 16;
  const block = image.subarray(0, blockSize);

  let off = 4;
  let ptag = 0xffffffff;
  while (off < blockSize) {
    const rawTag = readU32be(block, off);
    const tag = (rawTag ^ ptag) >>> 0;
    if (!tagIsValid(tag)) {
      throw new Error('failed to locate first commit end');
    }
    ptag = tag;
    off += tagDsize(tag);
    if ((tagType3(tag) & ~1) === LFS_TYPE_CCRC) {
      ptag ^= ((tag >>> 20) & 1) << 31;
      ptag >>>= 0;
      break;
    }
  }

  let commitOff = off;
  let crc = 0xffffffff;

  const appendEntry = (type3: number, id: number, data: Uint8Array): void => {
    const tag = mkTag(type3, id, data.length);
    const storedTag = (tag ^ ptag) >>> 0;
    writeU32be(block, commitOff, storedTag);
    crc = lfsCrc32(block.subarray(commitOff, commitOff + 4), crc);
    commitOff += 4;
    block.set(data, commitOff);
    crc = lfsCrc32(data, crc);
    commitOff += data.length;
    ptag = tag;
  };

  appendEntry(LFS_TYPE_INLINESTRUCT, opts.fileId, opts.content);

  if (opts.includeFcrc !== false) {
    const fcrcSize = progSize;
    const fcrcData = new Uint8Array(8);
    writeU32le(fcrcData, 0, fcrcSize);
    writeU32le(fcrcData, 4, opts.fcrcCrc ?? lfsCrc32(new Uint8Array(fcrcSize).fill(0xff)));
    appendEntry(LFS_TYPE_FCRC, 0x3ff, fcrcData);
  }

  const crcPadding = progSize > 1 ? (progSize - ((commitOff + 8) % progSize)) % progSize : 0;
  const crcDataSize = 4 + crcPadding;
  const crcTag = mkTag(LFS_TYPE_CCRC, 0x3ff, crcDataSize);
  const storedCrcTag = (crcTag ^ ptag) >>> 0;
  writeU32be(block, commitOff, storedCrcTag);
  crc = lfsCrc32(block.subarray(commitOff, commitOff + 4), crc);
  commitOff += 4;
  writeU32le(block, commitOff, crc);
  commitOff += 4;
  commitOff += crcPadding;
}

function appendMoveStateCommit(
  image: Uint8Array,
  opts: { blockSize?: number; pair?: [number, number]; moveState: Uint8Array },
): void {
  const blockSize = opts.blockSize ?? 4096;
  const pair = opts.pair ?? [0, 1];
  const block = image.subarray(pair[0] * blockSize, (pair[0] + 1) * blockSize);

  let off = 4;
  let ptag = 0xffffffff;
  while (off < blockSize) {
    const rawTag = readU32be(block, off);
    const tag = (rawTag ^ ptag) >>> 0;
    if (!tagIsValid(tag)) {
      throw new Error('failed to locate first commit end');
    }
    ptag = tag;
    off += tagDsize(tag);
    if ((tagType3(tag) & ~1) === LFS_TYPE_CCRC) {
      ptag ^= ((tag >>> 20) & 1) << 31;
      ptag >>>= 0;
      break;
    }
  }

  let commitOff = off;
  let crc = 0xffffffff;
  const tag = mkTag(LFS_TYPE_MOVESTATE, 0x3ff, opts.moveState.length);
  const storedTag = (tag ^ ptag) >>> 0;
  writeU32be(block, commitOff, storedTag);
  crc = lfsCrc32(block.subarray(commitOff, commitOff + 4), crc);
  commitOff += 4;
  block.set(opts.moveState, commitOff);
  crc = lfsCrc32(opts.moveState, crc);
  commitOff += opts.moveState.length;
  ptag = tag;

  const crcTag = mkTag(LFS_TYPE_CCRC, 0x3ff, 4);
  const storedCrcTag = (crcTag ^ ptag) >>> 0;
  writeU32be(block, commitOff, storedCrcTag);
  crc = lfsCrc32(block.subarray(commitOff, commitOff + 4), crc);
  commitOff += 4;
  writeU32le(block, commitOff, crc);
}

describe('LittleFS - CRC32', () => {
  it('computes CRC-32 consistent with littlefs C implementation', () => {
    const data = new TextEncoder().encode('littlefs');
    const crc = lfsCrc32(data);
    // Pre-computed expected value (no final inversion, init 0xFFFFFFFF)
    expect(crc).toBe(lfsCrc32(data, 0xffffffff));
    expect(typeof crc).toBe('number');
    expect(crc >>> 0).toBe(crc);
  });

  it('accumulates across multiple calls', () => {
    const full = new TextEncoder().encode('hello world');
    const part1 = new TextEncoder().encode('hello ');
    const part2 = new TextEncoder().encode('world');
    const crcFull = lfsCrc32(full);
    const crcAccum = lfsCrc32(part2, lfsCrc32(part1));
    expect(crcAccum).toBe(crcFull);
  });
});

describe('LittleFS - generate', () => {
  it('generates a valid littlefs image with empty root', () => {
    const source = createDir('root');
    const image = generate({ imageSize: 65536, source });
    expect(image.byteLength).toBe(65536);
    // Check magic string at offset 8 in block 0
    const magic = new TextDecoder().decode(image.subarray(8, 16));
    expect(magic).toBe('littlefs');
  });

  it('generates an image with a small inline file', () => {
    const content = new TextEncoder().encode('hello littlefs\n');
    const source = createDir('root', [createFile('hello.txt', content)]);
    const image = generate({ imageSize: 65536, source });
    expect(image.byteLength).toBe(65536);
  });

  it('generates an image with a large file (CTZ)', () => {
    const content = new TextEncoder().encode('A'.repeat(8192));
    const source = createDir('root', [createFile('large.bin', content)]);
    const image = generate({ imageSize: 65536, source });
    expect(image.byteLength).toBe(65536);
  });

  it('throws on image size not a multiple of block size', () => {
    const source = createDir('root');
    expect(() => generate({ imageSize: 5000, source })).toThrow(/multiple of block size/);
  });

  it('throws on file name too long', () => {
    const source = createDir('root', [createFile('a'.repeat(256), new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 65536, source })).toThrow(/exceeds name_max/);
  });
});

describe('LittleFS - parse', () => {
  it('round-trips an empty filesystem', () => {
    const source = createDir('root');
    const image = generate({ imageSize: 65536, source });
    const result = parse(image);
    expect(result.superblock.blockSize).toBe(4096);
    expect(result.superblock.blockCount).toBe(16);
    expect(result.files).toEqual([]);
  });

  it('round-trips a single inline file', () => {
    const content = new TextEncoder().encode('hello littlefs\n');
    const source = createDir('root', [createFile('hello.txt', content)]);
    const image = generate({ imageSize: 65536, source });
    const result = parse(image);

    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/hello.txt');
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('hello littlefs\n');
  });

  it('round-trips multiple inline files', () => {
    const contents = {
      'alpha.txt': new TextEncoder().encode('alpha\n'),
      'beta.txt': new TextEncoder().encode('beta\n'),
      'gamma.txt': new TextEncoder().encode('gamma\n'),
    };
    const source = createDir('root', [
      createFile('alpha.txt', contents['alpha.txt']),
      createFile('beta.txt', contents['beta.txt']),
      createFile('gamma.txt', contents['gamma.txt']),
    ]);
    const image = generate({ imageSize: 65536, source });
    const result = parse(image);

    expect(result.files.map((f) => f.path).sort()).toEqual([
      '/alpha.txt',
      '/beta.txt',
      '/gamma.txt',
    ]);
    for (const f of result.files) {
      const name = f.path.replace(/^\//, '') as keyof typeof contents;
      expect(new TextDecoder().decode(f.content)).toBe(new TextDecoder().decode(contents[name]));
    }
  });

  it('round-trips a large CTZ file', () => {
    const text = 'ABCDEFGHIJ'.repeat(500); // 5000 bytes
    const content = new TextEncoder().encode(text);
    const source = createDir('root', [createFile('big.txt', content)]);
    const image = generate({ imageSize: 65536, source });
    const result = parse(image);

    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/big.txt');
    expect(result.files[0]!.size).toBe(5000);
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe(text);
  });

  it('round-trips a multi-block CTZ file', () => {
    const content = new Uint8Array(22000).fill(0x41); // spans 6 CTZ blocks at 4 KiB
    const source = createDir('root', [createFile('huge.bin', content)]);
    const image = generate({ imageSize: 131072, source });
    const result = parse(image);

    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/huge.bin');
    expect(result.files[0]!.size).toBe(content.length);
    expect(result.files[0]!.content).toEqual(content);
  });

  it('parses the latest commit when a metadata block contains FCRC', () => {
    const source = createDir('root', [createFile('hello.txt', new TextEncoder().encode('old\n'))]);
    const image = generate({ imageSize: 65536, source });
    appendInlineCommitWithFcrc(image, {
      fileId: 1,
      content: new TextEncoder().encode('new\n'),
    });

    const result = parse(image);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe('/hello.txt');
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('new\n');
  });

  it('keeps compatibility with a later commit that has no FCRC', () => {
    const source = createDir('root', [createFile('hello.txt', new TextEncoder().encode('old\n'))]);
    const image = generate({ imageSize: 65536, source });
    appendInlineCommitWithFcrc(image, {
      fileId: 1,
      content: new TextEncoder().encode('new\n'),
      includeFcrc: false,
    });

    const result = parse(image);

    expect(result.files).toHaveLength(1);
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('new\n');
  });

  it('keeps the current commit but logs a warning when FCRC validation fails', () => {
    const source = createDir('root', [createFile('hello.txt', new TextEncoder().encode('old\n'))]);
    const image = generate({ imageSize: 65536, source });
    appendInlineCommitWithFcrc(image, {
      fileId: 1,
      content: new TextEncoder().encode('new\n'),
      fcrcCrc: 0,
    });

    const warnings: string[] = [];
    const result = parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(result.files).toHaveLength(1);
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('new\n');
    expect(result.warnings.some((warning) => /failed FCRC validation/.test(warning))).toBe(true);
    expect(warnings).toEqual(result.warnings);
  });

  it('round-trips mixed inline and CTZ files', () => {
    const small = new TextEncoder().encode('small\n');
    const large = new TextEncoder().encode('X'.repeat(2000));
    const source = createDir('root', [
      createFile('small.txt', small),
      createFile('large.bin', large),
    ]);
    const image = generate({ imageSize: 65536, source });
    const result = parse(image);

    expect(result.files.length).toBe(2);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(new TextDecoder().decode(byPath.get('/small.txt')!.content)).toBe('small\n');
    expect(byPath.get('/large.bin')!.size).toBe(2000);
    expect(new TextDecoder().decode(byPath.get('/large.bin')!.content)).toBe('X'.repeat(2000));
  });

  it('round-trips nested directories', () => {
    const source = createDir('root', [
      createDir('subdir', [createFile('inner.txt', new TextEncoder().encode('inside\n'))]),
      createFile('root.txt', new TextEncoder().encode('root\n')),
    ]);
    const image = generate({ imageSize: 65536, source });
    const result = parse(image);

    expect(result.files.map((f) => f.path).sort()).toEqual(['/root.txt', '/subdir/inner.txt']);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(new TextDecoder().decode(byPath.get('/subdir/inner.txt')!.content)).toBe('inside\n');
    expect(new TextDecoder().decode(byPath.get('/root.txt')!.content)).toBe('root\n');
  });

  it('round-trips deeply nested directories', () => {
    const source = createDir('root', [
      createDir('a', [
        createDir('b', [
          createDir('c', [createFile('deep.txt', new TextEncoder().encode('deep\n'))]),
        ]),
      ]),
    ]);
    const image = generate({ imageSize: 131072, source });
    const result = parse(image);

    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/a/b/c/deep.txt');
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('deep\n');
  });

  it('round-trips empty files', () => {
    const source = createDir('root', [createFile('empty.txt', new Uint8Array(0))]);
    const image = generate({ imageSize: 65536, source });
    const result = parse(image);

    expect(result.files.length).toBe(1);
    expect(result.files[0]!.size).toBe(0);
    expect(result.files[0]!.content.length).toBe(0);
  });

  it('logs a warning and keeps parsing when a file name contains invalid UTF-8 bytes', () => {
    const source = createDir('root', [
      createFile('hello.txt', new TextEncoder().encode('hello\n')),
    ]);
    const image = generate({ imageSize: 65536, source });
    const rootBlock = image.subarray(0, 4096);
    const nameOffset = findAsciiOffset(rootBlock, 'hello.txt');
    rootBlock[nameOffset] = 0xff;
    rewriteFirstCommitCrc(rootBlock, 4096);

    const warnings: string[] = [];
    const result = parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toContain('\ufffd');
    expect(result.warnings.some((warning) => /invalid UTF-8 bytes/.test(warning))).toBe(true);
    expect(warnings).toEqual(result.warnings);
  });

  it('logs a warning and skips entries with unsupported file types', () => {
    const source = createDir('root', [
      createFile('hello.txt', new TextEncoder().encode('hello\n')),
    ]);
    const image = generate({ imageSize: 65536, source });
    const rootBlock = image.subarray(0, 4096);

    rewriteFirstCommitTags(rootBlock, 4096, (tag, data) => {
      const name = new TextDecoder().decode(data);
      if (name !== 'hello.txt') return tag;
      return (tag & ~(0x7ff << 20)) | (0x07e << 20);
    });

    const warnings: string[] = [];
    const result = parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(result.files).toEqual([]);
    expect(result.warnings.some((warning) => /unsupported file type/.test(warning))).toBe(true);
    expect(warnings).toEqual(result.warnings);
  });

  it('preserves superblock metadata', () => {
    const source = createDir('root', [createFile('a.txt', new Uint8Array([42]))]);
    const image = generate({
      imageSize: 65536,
      source,
      blockSize: 4096,
      nameMax: 128,
    });
    const result = parse(image);

    expect(result.superblock.blockSize).toBe(4096);
    expect(result.superblock.blockCount).toBe(16);
    expect(result.superblock.nameMax).toBe(128);
  });

  it('throws ParseError on a corrupt CTZ predecessor pointer', () => {
    const source = createDir('root', [
      createFile('big.bin', new TextEncoder().encode('ABCDEFGHIJ'.repeat(500))),
    ]);
    const image = generate({ imageSize: 65536, source });

    const nameOffset = findAsciiOffset(image, 'big.bin');
    const ctzStructOffset = nameOffset + 'big.bin'.length + 4;
    const head = readU32leAt(image, ctzStructOffset);
    const blockSize = 4096;
    const headBlockBase = head * blockSize;
    writeU32leAt(image, headBlockBase, 0x7fffffff);

    expect(() => parse(image)).toThrow(ParseError);
    expect(() => parse(image)).toThrow(/invalid block/);
  });

  it('throws ParseError when the image is smaller than the superblock block count', () => {
    const source = createDir('root', [
      createFile('hello.txt', new TextEncoder().encode('hello\n')),
    ]);
    const fullImage = generate({ imageSize: 16 * 4096, source });
    const truncatedImage = fullImage.slice(0, 12 * 4096);

    expect(() => parse(truncatedImage)).toThrow(ParseError);
    expect(() => parse(truncatedImage)).toThrow(/image too small/);
  });

  it('throws ParseError on an active move-state delta', () => {
    const source = createDir('root', [
      createFile('hello.txt', new TextEncoder().encode('hello\n')),
    ]);
    const image = generate({ imageSize: 65536, source });
    const moveState = new Uint8Array(12);
    moveState[0] = 1;
    appendMoveStateCommit(image, { moveState });

    expect(() => parse(image)).toThrow(ParseError);
    expect(() => parse(image)).toThrow(/active move\/sync global state/);
  });

  it('throws ParseError on a directory cycle', () => {
    const source = createDir('root', [
      createDir('subdir', [createFile('inner.txt', new TextEncoder().encode('inside\n'))]),
    ]);
    const image = generate({ imageSize: 65536, source });
    const rootBlock = image.subarray(0, 4096);
    const subdirOffset = findAsciiOffset(rootBlock, 'subdir');
    const dirStructOffset = subdirOffset + 'subdir'.length + 4;
    writeU32leAt(rootBlock, dirStructOffset, 0);
    writeU32leAt(rootBlock, dirStructOffset + 4, 1);
    rewriteFirstCommitCrc(rootBlock, 4096);

    expect(() => parse(image)).toThrow(ParseError);
    expect(() => parse(image)).toThrow(/reserved superblock block|directory cycle/);
  });
});

describe('LittleFS - generate with custom config', () => {
  it('works with different block sizes', () => {
    const source = createDir('root', [createFile('test.txt', new TextEncoder().encode('test\n'))]);
    // 8192-byte blocks, 8 blocks = 65536 bytes
    const image = generate({ imageSize: 65536, source, blockSize: 8192 });
    const result = parse(image, { blockSize: 8192 });
    expect(result.superblock.blockSize).toBe(8192);
    expect(result.files.length).toBe(1);
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('test\n');
  });

  it('throws when block size is not aligned to read/prog sizes', () => {
    const source = createDir('root');
    expect(() => generate({ imageSize: 65536, source, blockSize: 4096, readSize: 24 })).toThrow(
      /multiple of read size/,
    );
    expect(() => generate({ imageSize: 65536, source, blockSize: 4096, progSize: 24 })).toThrow(
      /multiple of prog size/,
    );
  });

  it('throws when inline_max exceeds the littlefs limit', () => {
    const source = createDir('root');
    expect(() => generate({ imageSize: 65536, source, inlineMax: 1023 })).toThrow(
      /inline_max must be/,
    );
  });
});

describe('LittleFS - metadata split', () => {
  it('round-trips a root directory that requires metadata split', () => {
    // Use small block size (512) so the root metadata overflows quickly.
    // Each file entry: 4(tag) + name + 4(tag) + content ≈ 20+ bytes.
    // With superblock overhead (~60 bytes), ~15 files should overflow 512.
    const blockSize = 512;
    const blockCount = 128;
    const children: VirtualNode[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `file_${String(i).padStart(3, '0')}.txt`;
      children.push(createFile(name, new TextEncoder().encode(`content ${i}\n`)));
    }
    const source = createDir('root', children);
    const image = generate({ imageSize: blockSize * blockCount, source, blockSize });
    const result = parse(image, { blockSize });

    expect(result.files.length).toBe(20);
    const paths = result.files.map((f) => f.path).sort();
    for (let i = 0; i < 20; i++) {
      const name = `file_${String(i).padStart(3, '0')}.txt`;
      expect(paths).toContain(`/${name}`);
    }
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    for (let i = 0; i < 20; i++) {
      const name = `file_${String(i).padStart(3, '0')}.txt`;
      expect(new TextDecoder().decode(byPath.get(`/${name}`)!.content)).toBe(`content ${i}\n`);
    }
  });

  it('round-trips a subdirectory that requires metadata split', () => {
    const blockSize = 512;
    const blockCount = 128;
    const subChildren: VirtualNode[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `item_${String(i).padStart(3, '0')}.txt`;
      subChildren.push(createFile(name, new TextEncoder().encode(`sub ${i}\n`)));
    }
    const source = createDir('root', [createDir('big_dir', subChildren)]);
    const image = generate({ imageSize: blockSize * blockCount, source, blockSize });
    const result = parse(image, { blockSize });

    expect(result.files.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      const name = `item_${String(i).padStart(3, '0')}.txt`;
      const file = result.files.find((f) => f.path === `/big_dir/${name}`);
      expect(file, `missing /big_dir/${name}`).toBeDefined();
      expect(new TextDecoder().decode(file!.content)).toBe(`sub ${i}\n`);
    }
  });

  it('throws when a single entry exceeds block capacity', () => {
    // Use blockSize=128. Superblock overhead: rev(4) + tag(4)+8 + tag(4)+24 + crc(8) = 52.
    // Remaining: 128 - 52 = 76 bytes for one entry.
    // One file: tag(4) + name(100) + tag(4) + inline/ctz ≥ 108 bytes → overflow.
    const blockSize = 128;
    const blockCount = 256;
    const longName = 'x'.repeat(100) + '.txt'; // 104 chars
    const source = createDir('root', [createFile(longName, new TextEncoder().encode('data'))]);
    expect(() => generate({ imageSize: blockSize * blockCount, source, blockSize })).toThrow(
      /exceeds metadata block capacity/,
    );
  });
});

/*
 * Cross-validation: parse images generated by littlefs-python (C reference).
 * Run `uv run scripts/build-fixtures-littlefs.py` to (re)generate fixtures.
 * Tests are skipped when fixture files are absent.
 */
describe('LittleFS - cross-validation with littlefs-python', () => {
  const skip = !hasFixture('littlefs_empty.bin');

  it.skipIf(skip)('parses empty image from littlefs-python', () => {
    const image = loadFixture('littlefs_empty.bin');
    const result = parse(image);
    expect(result.superblock.blockSize).toBe(4096);
    expect(result.superblock.blockCount).toBe(16);
    expect(result.files).toEqual([]);
  });

  it.skipIf(skip)('parses single inline file from littlefs-python', () => {
    const image = loadFixture('littlefs_single.bin');
    const result = parse(image);
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/hello.txt');
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('Hello from LittleFS!\n');
  });

  it.skipIf(skip)('parses multiple inline files from littlefs-python', () => {
    const image = loadFixture('littlefs_multi.bin');
    const result = parse(image);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      '/alpha.txt',
      '/beta.txt',
      '/gamma.txt',
    ]);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(new TextDecoder().decode(byPath.get('/alpha.txt')!.content)).toBe('alpha\n');
    expect(new TextDecoder().decode(byPath.get('/beta.txt')!.content)).toBe('beta\n');
    expect(new TextDecoder().decode(byPath.get('/gamma.txt')!.content)).toBe('gamma\n');
  });

  it.skipIf(skip)('parses large CTZ file from littlefs-python', () => {
    const image = loadFixture('littlefs_large.bin');
    const result = parse(image);
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/big.txt');
    expect(result.files[0]!.size).toBe(5000);
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('ABCDEFGHIJ'.repeat(500));
  });

  it.skipIf(skip)('parses nested directories from littlefs-python', () => {
    const image = loadFixture('littlefs_nested.bin');
    const result = parse(image);
    expect(result.files.map((f) => f.path).sort()).toEqual(['/root.txt', '/subdir/inner.txt']);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(new TextDecoder().decode(byPath.get('/root.txt')!.content)).toBe('root\n');
    expect(new TextDecoder().decode(byPath.get('/subdir/inner.txt')!.content)).toBe(
      'nested file content\n',
    );
  });

  it.skipIf(skip)('parses deeply nested directories from littlefs-python', () => {
    const image = loadFixture('littlefs_deep.bin');
    const result = parse(image);
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/a/b/c/deep.txt');
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe('deep\n');
  });

  it.skipIf(skip)('parses image built from source directory by littlefs-python', () => {
    if (!hasFixture('littlefs_from_src.bin')) return;
    const image = loadFixture('littlefs_from_src.bin');
    const result = parse(image);
    expect(result.files.length).toBeGreaterThanOrEqual(2);
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toContain('/hello.txt');
    expect(paths).toContain('/subdir/inner.txt');
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(new TextDecoder().decode(byPath.get('/hello.txt')!.content)).toBe(
      'Hello from LittleFS!\n',
    );
    expect(new TextDecoder().decode(byPath.get('/subdir/inner.txt')!.content)).toBe(
      'nested file content\n',
    );
  });

  it.skipIf(skip)('parses empty file from littlefs-python', () => {
    const image = loadFixture('littlefs_empty_file.bin');
    const result = parse(image);
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/empty.txt');
    expect(result.files[0]!.size).toBe(0);
  });

  it.skipIf(skip)('parses mixed inline and CTZ from littlefs-python', () => {
    const image = loadFixture('littlefs_mixed.bin');
    const result = parse(image);
    expect(result.files.length).toBe(2);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(new TextDecoder().decode(byPath.get('/small.txt')!.content)).toBe('small\n');
    expect(byPath.get('/large.bin')!.size).toBe(2000);
    expect(new TextDecoder().decode(byPath.get('/large.bin')!.content)).toBe('X'.repeat(2000));
  });
});

/*
 * Reverse cross-validation: TS generates images → littlefs-python (C reference) parses them.
 * Requires python3 with littlefs-python installed; tests are skipped otherwise.
 */
describe('LittleFS - reverse cross-validation (TS writer → Python parser)', () => {
  const skip = !hasPythonLittlefs();

  it.skipIf(skip)('Python parses TS-generated empty image', () => {
    const image = generate({ imageSize: 65536, source: createDir('root') });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    expect(result.superblock.blockSize).toBe(4096);
    expect(result.superblock.blockCount).toBe(16);
    expect(result.files).toEqual([]);
  });

  it.skipIf(skip)('Python parses TS-generated single inline file', () => {
    const content = 'Hello from LittleFS!\n';
    const source = createDir('root', [createFile('hello.txt', new TextEncoder().encode(content))]);
    const image = generate({ imageSize: 65536, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/hello.txt');
    expect(result.files[0]!.size).toBe(content.length);
    expect(Buffer.from(result.files[0]!.hex, 'hex').toString()).toBe(content);
  });

  it.skipIf(skip)('Python parses TS-generated multiple inline files', () => {
    const source = createDir('root', [
      createFile('alpha.txt', new TextEncoder().encode('alpha\n')),
      createFile('beta.txt', new TextEncoder().encode('beta\n')),
      createFile('gamma.txt', new TextEncoder().encode('gamma\n')),
    ]);
    const image = generate({ imageSize: 65536, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(['/alpha.txt', '/beta.txt', '/gamma.txt']);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(Buffer.from(byPath.get('/alpha.txt')!.hex, 'hex').toString()).toBe('alpha\n');
    expect(Buffer.from(byPath.get('/beta.txt')!.hex, 'hex').toString()).toBe('beta\n');
    expect(Buffer.from(byPath.get('/gamma.txt')!.hex, 'hex').toString()).toBe('gamma\n');
  });

  it.skipIf(skip)('Python parses TS-generated large CTZ file', () => {
    const text = 'ABCDEFGHIJ'.repeat(500);
    const source = createDir('root', [createFile('big.txt', new TextEncoder().encode(text))]);
    const image = generate({ imageSize: 65536, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/big.txt');
    expect(result.files[0]!.size).toBe(5000);
    expect(Buffer.from(result.files[0]!.hex, 'hex').toString()).toBe(text);
  });

  it.skipIf(skip)('Python parses TS-generated multi-block CTZ file', () => {
    const text = 'A'.repeat(22000);
    const source = createDir('root', [createFile('huge.bin', new TextEncoder().encode(text))]);
    const image = generate({ imageSize: 131072, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/huge.bin');
    expect(result.files[0]!.size).toBe(22000);
    expect(Buffer.from(result.files[0]!.hex, 'hex').toString()).toBe(text);
  });

  it.skipIf(skip)('Python parses TS-generated nested directories', () => {
    const source = createDir('root', [
      createDir('subdir', [
        createFile('inner.txt', new TextEncoder().encode('nested file content\n')),
      ]),
      createFile('root.txt', new TextEncoder().encode('root\n')),
    ]);
    const image = generate({ imageSize: 65536, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(['/root.txt', '/subdir/inner.txt']);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(Buffer.from(byPath.get('/root.txt')!.hex, 'hex').toString()).toBe('root\n');
    expect(Buffer.from(byPath.get('/subdir/inner.txt')!.hex, 'hex').toString()).toBe(
      'nested file content\n',
    );
  });

  it.skipIf(skip)('Python parses TS-generated deeply nested directories', () => {
    const source = createDir('root', [
      createDir('a', [
        createDir('b', [
          createDir('c', [createFile('deep.txt', new TextEncoder().encode('deep\n'))]),
        ]),
      ]),
    ]);
    const image = generate({ imageSize: 131072, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/a/b/c/deep.txt');
    expect(Buffer.from(result.files[0]!.hex, 'hex').toString()).toBe('deep\n');
  });

  it.skipIf(skip)('Python parses TS-generated empty file', () => {
    const source = createDir('root', [createFile('empty.txt', new Uint8Array(0))]);
    const image = generate({ imageSize: 65536, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toBe('/empty.txt');
    expect(result.files[0]!.size).toBe(0);
  });

  it.skipIf(skip)('Python parses TS-generated root metadata soft-tail chain', () => {
    const blockSize = 512;
    const blockCount = 128;
    const children: VirtualNode[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `file_${String(i).padStart(3, '0')}.txt`;
      children.push(createFile(name, new TextEncoder().encode(`content ${i}\n`)));
    }

    const image = generate({
      imageSize: blockSize * blockCount,
      source: createDir('root', children),
      blockSize,
    });
    const result = verifyWithPython(image, blockSize);
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(20);
    expect(result.files.map((file) => file.path).sort()).toEqual(
      children.map((child) => `/${child.name}`).sort(),
    );
  });

  it.skipIf(skip)('Python parses TS-generated mixed inline and CTZ', () => {
    const source = createDir('root', [
      createFile('small.txt', new TextEncoder().encode('small\n')),
      createFile('large.bin', new Uint8Array(2000).fill(0x58)), // 'X'
    ]);
    const image = generate({ imageSize: 65536, source });
    const result = verifyWithPython(image);
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBe(2);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(Buffer.from(byPath.get('/small.txt')!.hex, 'hex').toString()).toBe('small\n');
    expect(byPath.get('/large.bin')!.size).toBe(2000);
    expect(Buffer.from(byPath.get('/large.bin')!.hex, 'hex').toString()).toBe('X'.repeat(2000));
  });
});
