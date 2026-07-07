import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDir, createFile } from '../src/common/virtual-fs.js';
import type { ParseWarning } from '../src/common/diagnostics.js';
import {
  flatten,
  generate,
  parse,
  computeWlLayout,
  parseStateHeader,
  removeWearLeveling,
  wrapWearLeveling,
  WL_SECTOR_SIZE,
  WL_FAT_SECTOR_SIZE_512,
  WL_STATE_HEADER_SIZE,
} from '../src/fatfs/index.js';
import {
  buildDateEntry,
  buildTimeEntry,
  FAT12,
  FAT16,
  getFatSectorsCountForType,
  getFatfsType,
} from '../src/fatfs/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

describe('FatFS - generate', () => {
  it('selects FAT type from data clusters without adding reserved FAT entries', () => {
    expect(getFatfsType(4085)).toBe(12);
    expect(getFatfsType(4086)).toBe(16);
    expect(getFatfsType(65525)).toBe(16);
    expect(getFatfsType(65526)).toBe(32);
  });

  it('validates FAT date/time fields using FatFs-compatible ranges', () => {
    expect(() => buildDateEntry(1979, 1, 1)).toThrow(/year/i);
    expect(() => buildDateEntry(1980, 0, 1)).toThrow(/month/i);
    expect(() => buildDateEntry(1980, 1, 0)).toThrow(/day/i);
    expect(() => buildTimeEntry(24, 0, 0)).toThrow(/hour/i);
    expect(() => buildTimeEntry(0, 60, 0)).toThrow(/minute/i);
    expect(() => buildTimeEntry(0, 0, 60)).toThrow(/second/i);
    expect(buildDateEntry(1980, 1, 1)).toBe(0x0021);
    expect(buildTimeEntry(23, 59, 59)).toBe(0xbf7d);
  });

  it('matches fatfsgen.py output except for the volume UUID', () => {
    const src = join(fixtures, 'fatfs_src');
    const source = createDir('fatfs_src', [
      createFile('HELLO.TXT', new Uint8Array(readFileSync(join(src, 'HELLO.TXT')))),
      createFile('README.MD', new Uint8Array(readFileSync(join(src, 'README.MD')))),
    ]);
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_basic.img')));

    // Extract python-generated VolID so we produce an otherwise byte-identical
    // image. BS_VolID lives at offset 39 (4 bytes LE).
    const volumeUuid = new DataView(golden.buffer).getUint32(39, true);

    const produced = generate({
      size: golden.byteLength,
      source,
      volumeUuid,
      longFilenames: false,
    });
    expect(produced.byteLength).toBe(golden.byteLength);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 40) break;
    }
    expect(diffs, `diff at offsets ${diffs.slice(0, 20).join(',')}`).toEqual([]);
  });

  it('uses current IDF numbered aliases for LFN entries', () => {
    const src = join(fixtures, 'fatfs_lfn');
    const source = createDir('fatfs_lfn', [
      createFile(
        'hello_long_name.txt',
        new Uint8Array(readFileSync(join(src, 'hello_long_name.txt'))),
      ),
      createFile('MixedCase.TXT', new Uint8Array(readFileSync(join(src, 'MixedCase.TXT')))),
      createFile('SHORT.TXT', new Uint8Array(readFileSync(join(src, 'SHORT.TXT')))),
    ]);
    const produced = generate({ size: 512 * 1024, source, volumeUuid: 0 });

    const helloAlias = new TextEncoder().encode('HELLO_~1TXT');
    const mixedAlias = new TextEncoder().encode('MIXEDC~1TXT');
    let seenHelloAlias = false;
    let seenMixedAlias = false;
    for (let i = 0; i + 11 <= produced.byteLength; i++) {
      const window = produced.subarray(i, i + 11);
      if (!seenHelloAlias && window.every((v, idx) => v === helloAlias[idx])) seenHelloAlias = true;
      if (!seenMixedAlias && window.every((v, idx) => v === mixedAlias[idx])) seenMixedAlias = true;
    }

    expect(seenHelloAlias).toBe(true);
    expect(seenMixedAlias).toBe(true);
  });

  it('avoids colliding an LFN alias with an existing short 8.3 entry', () => {
    const source = createDir('root', [
      createFile('ABCDEF~1.TXT', new TextEncoder().encode('short\n')),
      createFile('abcdefghi.txt', new TextEncoder().encode('long\n')),
    ]);
    const img = generate({ size: 524288, source });
    const alias1 = new TextEncoder().encode('ABCDEF~1TXT');
    const alias2 = new TextEncoder().encode('ABCDEF~2TXT');

    let seenAlias1 = false;
    let seenAlias2 = false;
    for (let i = 0; i + 11 <= img.byteLength; i++) {
      const window = img.subarray(i, i + 11);
      if (!seenAlias1 && window.every((v, idx) => v === alias1[idx])) seenAlias1 = true;
      if (!seenAlias2 && window.every((v, idx) => v === alias2[idx])) seenAlias2 = true;
    }

    expect(seenAlias1).toBe(true);
    expect(seenAlias2).toBe(true);
  });

  it('supports larger LFN collision sets like current IDF', () => {
    const source = createDir('root', [
      createFile('prefix_collision_01.txt', new TextEncoder().encode('1')),
      createFile('prefix_collision_02.txt', new TextEncoder().encode('2')),
      createFile('prefix_collision_03.txt', new TextEncoder().encode('3')),
      createFile('prefix_collision_04.txt', new TextEncoder().encode('4')),
      createFile('prefix_collision_05.txt', new TextEncoder().encode('5')),
      createFile('prefix_collision_06.txt', new TextEncoder().encode('6')),
      createFile('prefix_collision_07.txt', new TextEncoder().encode('7')),
      createFile('prefix_collision_08.txt', new TextEncoder().encode('8')),
      createFile('prefix_collision_09.txt', new TextEncoder().encode('9')),
      createFile('prefix_collision_10.txt', new TextEncoder().encode('10')),
    ]);
    const img = generate({ size: 524288, source, espIdfCompat: false });
    let seenExtendedAlias = false;
    for (let i = 0; i + 32 <= img.byteLength; i += 32) {
      if (img[i + 11] !== 0x20) continue;
      const shortName = new TextDecoder().decode(img.subarray(i, i + 8)).trimEnd();
      if (/~[0-9A-F]{2,}$/u.test(shortName)) {
        seenExtendedAlias = true;
        break;
      }
    }
    expect(seenExtendedAlias).toBe(true);

    const { root } = parse(img);
    expect(flatten(root)).toHaveLength(10);
  });

  it('supports LFN collision orders above 99 like IDF Python does', () => {
    const source = createDir(
      'root',
      Array.from({ length: 100 }, (_, i) =>
        createFile(
          `prefix_collision_${String(i + 1).padStart(3, '0')}.txt`,
          new TextEncoder().encode(String(i + 1)),
        ),
      ),
    );
    const img = generate({ size: 2 * 1024 * 1024, source, espIdfCompat: false });
    const { root } = parse(img);
    expect(flatten(root)).toHaveLength(100);
  });

  it('scopes LFN short-alias collisions to a single directory', () => {
    const source = createDir('root', [
      createDir('DIR1', [createFile('abcdefghi.txt', new TextEncoder().encode('1'))]),
      createDir('DIR2', [createFile('abcdefghi.txt', new TextEncoder().encode('2'))]),
    ]);
    const img = generate({ size: 524288, source });
    const alias = new TextEncoder().encode('ABCDEF~1TXT');
    let aliasCount = 0;
    for (let i = 0; i + 11 <= img.byteLength; i++) {
      const window = img.subarray(i, i + 11);
      if (window.every((v, idx) => v === alias[idx])) aliasCount += 1;
    }
    expect(aliasCount).toBe(2);

    const { root } = parse(img);
    const entries = flatten(root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries.map((e) => e.path)).toEqual(['dir1/abcdefghi.txt', 'dir2/abcdefghi.txt']);
  });

  it('throws instead of emitting an auto FAT32-sized FAT16-style image', () => {
    const source = createDir('root', [createFile('A.TXT', new Uint8Array(0))]);
    expect(() =>
      generate({
        size: 300 * 1024 * 1024,
        source,
        sectorSize: 4096,
        sectorsPerCluster: 1,
      }),
    ).toThrow(/FatFs classifies as FAT32/i);
  });

  it('rejects FAT32 layouts whose backup FSInfo would fall outside the reserved region', () => {
    const source = createDir('root', [createFile('A.TXT', new Uint8Array(0))]);
    expect(() =>
      generate({
        size: 48 * 1024 * 1024,
        source,
        sectorSize: 512,
        sectorsPerCluster: 1,
        explicitFatType: 32,
        reservedSectorsCount: 7,
      }),
    ).toThrow(/at least 8 reserved sectors/i);
  });

  it('throws instead of silently downgrading an explicit FAT32 request to FAT12/16', () => {
    const source = createDir('root', [createFile('A.TXT', new Uint8Array(0))]);
    expect(() =>
      generate({
        size: 8 * 1024 * 1024,
        source,
        sectorSize: 512,
        sectorsPerCluster: 1,
        explicitFatType: 32,
      }),
    ).toThrow(/explicitFatType: 32 requires more than 65525 data clusters/i);
  });

  it('rejects an explicit FAT16 request when the layout is actually FAT12', () => {
    const source = createDir('root', [createFile('A.TXT', new Uint8Array([0x41]))]);
    expect(() =>
      generate({
        size: 512 * 1024,
        source,
        sectorSize: 512,
        explicitFatType: 16,
        longFilenames: false,
      }),
    ).toThrow(/explicitFatType: 16 is inconsistent/i);
  });

  it('rejects an explicit FAT12 request when the layout is actually FAT16', () => {
    const source = createDir('root', [createFile('A.TXT', new Uint8Array([0x41]))]);
    expect(() =>
      generate({
        size: 8 * 1024 * 1024,
        source,
        sectorSize: 512,
        sectorsPerCluster: 1,
        explicitFatType: 12,
        longFilenames: false,
      }),
    ).toThrow(/explicitFatType: 12 is inconsistent/i);
  });

  it('sizes FAT12/16 from data clusters even when sectorsPerCluster > 1', () => {
    const sectorSize = 512;
    const sectorsPerCluster = 8;
    const fatTablesCount = 2;
    const rootEntryCount = 512;
    const img = generate({
      size: 8 * 1024 * 1024,
      source: createDir('root', [createFile('A.TXT', new Uint8Array([0x41]))]),
      sectorSize,
      sectorsPerCluster,
      fatTablesCount,
      rootEntryCount,
    });
    const parsed = parse(img);
    const rootDirSectors = (rootEntryCount * 32) / sectorSize;
    let expectedFatSectors = 1;
    let expectedType: 12 | 16 = FAT12;
    for (let i = 0; i < 8; i++) {
      const dataSectors =
        parsed.boot.totalSectors -
        parsed.boot.reservedSectorsCount -
        expectedFatSectors * fatTablesCount -
        rootDirSectors;
      const dataClusters = Math.floor(dataSectors / sectorsPerCluster);
      expectedType = getFatfsType(dataClusters) === FAT12 ? FAT12 : FAT16;
      expectedFatSectors = getFatSectorsCountForType(dataClusters, sectorSize, expectedType);
    }
    expect(parsed.boot.fatType).toBe(expectedType);
    expect(parsed.boot.fatSectorsCount).toBe(expectedFatSectors);
  });

  it('rejects filenames that FatFs path parsing cannot address', () => {
    expect(() =>
      generate({
        size: 524288,
        source: createDir('root', [createFile('FOO?BAR.TXT', new Uint8Array(0))]),
      }),
    ).toThrow(/not accepted by FatFs/i);
  });

  it('sets DIR_NTRes=0x18 on pure SFN entries when LFN + espIdfCompat are enabled', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createFile('SHORT.TXT', new TextEncoder().encode('x'))]),
      espIdfCompat: true,
    });
    let shortOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i] === 0x53 && img[i + 11] === 0x20) {
        shortOffset = i;
        break;
      }
    }
    expect(shortOffset).toBeGreaterThanOrEqual(0);
    expect(img[shortOffset + 12]).toBe(0x18);
    expect(flatten(parse(img).root).map((entry) => entry.path)).toEqual(['short.txt']);
  });

  it('leaves DIR_NTRes zero on pure SFN entries when longFilenames is disabled', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createFile('SHORT.TXT', new TextEncoder().encode('x'))]),
      longFilenames: false,
    });
    let shortOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i] === 0x53 && img[i + 11] === 0x20) {
        shortOffset = i;
        break;
      }
    }
    expect(shortOffset).toBeGreaterThanOrEqual(0);
    expect(img[shortOffset + 12]).toBe(0x00);
    expect(flatten(parse(img).root).map((entry) => entry.path)).toEqual(['SHORT.TXT']);
  });

  it('leaves DIR_NTRes zero on pure SFN when espIdfCompat is disabled', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createFile('SHORT.TXT', new TextEncoder().encode('x'))]),
      espIdfCompat: false,
    });
    let shortOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i] === 0x53 && img[i + 11] === 0x20) {
        shortOffset = i;
        break;
      }
    }
    expect(shortOffset).toBeGreaterThanOrEqual(0);
    expect(img[shortOffset + 12]).toBe(0x00);
    expect(flatten(parse(img).root).map((entry) => entry.path)).toEqual(['SHORT.TXT']);
  });

  it('uses LFN for short-name-invalid but LFN-valid names', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [
        createFile('ABC DEF.TXT', new TextEncoder().encode('space\n')),
        createFile('A+B.TXT', new TextEncoder().encode('plus\n')),
      ]),
      espIdfCompat: false,
    });
    const paths = flatten(parse(img).root)
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['A+B.TXT', 'ABC DEF.TXT']);
  });

  it('round-trips non-ASCII long filenames through UTF-16 LFN entries', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [
        createFile('é.txt', new TextEncoder().encode('accent\n')),
        createFile('文件.txt', new TextEncoder().encode('cjk\n')),
        createFile('😀.txt', new TextEncoder().encode('emoji\n')),
      ]),
      espIdfCompat: false,
    });
    const paths = flatten(parse(img).root)
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['é.txt', '文件.txt', '😀.txt'].sort());
  });

  it('supports non-ASCII LFN in the default ESP-IDF-compatible mode', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createFile('é.txt', new TextEncoder().encode('accent\n'))]),
    });
    expect(flatten(parse(img).root).map((entry) => entry.path)).toEqual(['é.txt']);
  });

  it('matches fatfsgen.py for nested directories', () => {
    const root = join(fixtures, 'fatfs_nested');
    const source = createDir('fatfs_nested', [
      createDir('SUB', [
        createFile('INNER.TXT', new Uint8Array(readFileSync(join(root, 'SUB', 'INNER.TXT')))),
      ]),
      createFile('TOP.TXT', new Uint8Array(readFileSync(join(root, 'TOP.TXT')))),
    ]);
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_nested.img')));
    const volumeUuid = new DataView(golden.buffer).getUint32(39, true);
    const produced = generate({
      size: golden.byteLength,
      source,
      volumeUuid,
      longFilenames: false,
    });
    expect(produced.byteLength).toBe(golden.byteLength);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 40) break;
    }
    expect(diffs, `diff at offsets ${diffs.slice(0, 20).join(',')}`).toEqual([]);
  });
});

describe('FatFS - parse', () => {
  it('restores files from a basic image', () => {
    const src = join(fixtures, 'fatfs_src');
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_basic.img')));
    const { boot, root, warnings } = parse(golden);
    expect(boot.fatType).toBe(12);
    expect(boot.volumeLabel).toBe('Espressif');
    expect(warnings).toEqual([]);
    const files = flatten(root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(files.map((f) => f.path)).toEqual(['HELLO.TXT', 'README.MD']);
    expect(new Uint8Array(files[0]!.content)).toEqual(
      new Uint8Array(readFileSync(join(src, 'HELLO.TXT'))),
    );
    expect(new Uint8Array(files[1]!.content)).toEqual(
      new Uint8Array(readFileSync(join(src, 'README.MD'))),
    );
  });

  it('restores files from a nested image', () => {
    const root = join(fixtures, 'fatfs_nested');
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_nested.img')));
    const parsed = parse(golden);
    expect(parsed.warnings).toEqual([]);
    const files = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(files.map((f) => f.path)).toEqual(['SUB/INNER.TXT', 'TOP.TXT']);
    expect(new Uint8Array(files[0]!.content)).toEqual(
      new Uint8Array(readFileSync(join(root, 'SUB', 'INNER.TXT'))),
    );
    expect(new Uint8Array(files[1]!.content)).toEqual(
      new Uint8Array(readFileSync(join(root, 'TOP.TXT'))),
    );
  });

  it('reassembles long filenames from an LFN image', () => {
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_lfn.img')));
    const { root } = parse(golden);
    const names = flatten(root)
      .map((f) => f.path)
      .sort();
    // ESP-IDF uppercases before writing LFN and then lowercases the UTF-16
    // bytes, so the readable long name is the lower-case form of the path.
    // Its SFN-only entry also carries DIR_NTRes lowercase flags, which decode
    // to `short.txt` under FatFs semantics.
    expect(names).toEqual(['hello_long_name.txt', 'mixedcase.txt', 'short.txt']);
  });

  it('round-trips standards-compliant LFN (espIdfCompat=false)', () => {
    const source = createDir('root', [
      createFile('ReadMe Here.txt', new TextEncoder().encode('hi\n')),
      createFile('SHORT.TXT', new TextEncoder().encode('short\n')),
    ]);
    const img = generate({ size: 524288, source, espIdfCompat: false });
    // Standard mode uses ASCII '~1' byte 0x31 in the short alias.
    // Search for 'READM~1' (6 chars + '~' + '1').
    let foundStandardAlias = false;
    for (let i = 0; i + 8 < img.byteLength; i++) {
      if (
        img[i] === 0x52 &&
        img[i + 1] === 0x45 &&
        img[i + 2] === 0x41 &&
        img[i + 3] === 0x44 &&
        img[i + 4] === 0x4d &&
        img[i + 5] === 0x45 &&
        img[i + 6] === 0x7e &&
        img[i + 7] === 0x31
      ) {
        foundStandardAlias = true;
        break;
      }
    }
    expect(foundStandardAlias).toBe(true);
    const { root } = parse(img);
    const names = flatten(root)
      .map((f) => f.path)
      .sort();
    expect(names).toEqual(['ReadMe Here.txt', 'SHORT.TXT']);
  });

  it('applies DIR_NTRes lowercase flags when no valid LFN is present', () => {
    const source = createDir('root', [createFile('README.TXT', new TextEncoder().encode('hi\n'))]);
    const img = generate({ size: 524288, source });

    let shortOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i + 11] === 0x20 && img[i] === 0x52) {
        shortOffset = i;
        break;
      }
    }
    expect(shortOffset).toBeGreaterThanOrEqual(0);
    img[shortOffset + 12] = 0x18;

    const { root } = parse(img);
    expect(flatten(root).map((f) => f.path)).toEqual(['readme.txt']);
  });

  it('ignores malformed LFN entries with non-zero type or first-cluster fields', () => {
    const source = createDir('root', [
      createFile('ReadMe Here.txt', new TextEncoder().encode('hi\n')),
    ]);
    const img = generate({ size: 524288, source, espIdfCompat: false });

    let lfnOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i + 11] === 0x0f) {
        lfnOffset = i;
        break;
      }
    }
    expect(lfnOffset).toBeGreaterThanOrEqual(0);
    img[lfnOffset + 12] = 0x01;
    img[lfnOffset + 26] = 0x01;

    const parsed = parse(img);
    const names = flatten(parsed.root).map((f) => f.path);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe('ReadMe Here.txt');
  });

  it('logs a warning and falls back to the short name when an LFN chain is broken', () => {
    const source = createDir('root', [
      createFile('ReadMe Here.txt', new TextEncoder().encode('hi\n')),
    ]);
    const img = generate({ size: 524288, source, espIdfCompat: false });

    let lfnOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i + 11] === 0x0f) {
        lfnOffset = i;
        break;
      }
    }
    expect(lfnOffset).toBeGreaterThanOrEqual(0);
    img[lfnOffset + 13] = 0x00;

    const warnings: ParseWarning[] = [];
    const parsed = parse(img, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    const names = flatten(parsed.root).map((f) => f.path);

    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe('ReadMe Here.txt');
    expect(parsed.warnings.some((warning) => /LFN/.test(warning.reason))).toBe(true);
    expect(warnings).toEqual(parsed.warnings);
  });

  it('warns on non-contiguous LFN chains but still decodes what it can', () => {
    const source = createDir('root', [
      createFile('this_is_a_long_name.txt', new TextEncoder().encode('hi\n')),
    ]);
    const img = generate({ size: 524288, source, espIdfCompat: false });

    const lfnOffsets: number[] = [];
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i + 11] === 0x0f) lfnOffsets.push(i);
      else if (lfnOffsets.length > 0) break;
    }
    expect(lfnOffsets.length).toBeGreaterThan(1);
    img[lfnOffsets[1]! + 0] = 0x03;

    const parsed = parse(img);
    expect(flatten(parsed.root)).toHaveLength(1);
    expect(
      parsed.warnings.some((warning) => /non-contiguous|out-of-order/i.test(warning.reason)),
    ).toBe(true);
  });

  it('throws on a directory cycle created by a self-referential child entry', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createDir('LOOP', [createDir('SUB', [])])]),
    });

    let subOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i] === 0x53 && img[i + 1] === 0x55 && img[i + 2] === 0x42 && img[i + 11] === 0x10) {
        subOffset = i;
        break;
      }
    }
    expect(subOffset).toBeGreaterThanOrEqual(0);

    // Rewrite SUB's first cluster to point back to its parent directory.
    img[subOffset + 26] = 0x02;
    img[subOffset + 27] = 0x00;

    expect(() => parse(img)).toThrow(/directory cycle/i);
  });

  it('warns and truncates a file chain that starts from an out-of-range cluster', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createFile('A.TXT', new TextEncoder().encode('hello\n'))]),
      longFilenames: false,
    });

    const view = new DataView(img.buffer, img.byteOffset, img.byteLength);
    const sectorSize = view.getUint16(11, true);
    const reserved = view.getUint16(14, true);
    const fatCount = img[16]!;
    const rootEntryCount = view.getUint16(17, true);
    const fatSectors = view.getUint16(22, true);
    const rootDirStart = (reserved + fatSectors * fatCount) * sectorSize;
    const rootDirBytes = rootEntryCount * 32;

    let fileOffset = -1;
    for (let i = rootDirStart; i + 32 <= rootDirStart + rootDirBytes; i += 32) {
      if (img[i] === 0x41 && img[i + 11] === 0x20) {
        fileOffset = i;
        break;
      }
    }
    expect(fileOffset).toBeGreaterThanOrEqual(0);
    img[fileOffset + 26] = 0xfe;
    img[fileOffset + 27] = 0xff;

    const parsed = parse(img);
    expect(parsed.warnings.some((warning) => /out-of-range cluster/i.test(warning.reason))).toBe(
      true,
    );
    const entries = flatten(parsed.root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('A.TXT');
    expect(entries[0]!.content).toEqual(new Uint8Array(0));
  });

  it('warns and recovers an invalid directory start cluster as an empty directory', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createDir('SUB', [createFile('A.TXT', new Uint8Array([0x41]))])]),
      longFilenames: false,
    });

    let subOffset = -1;
    for (let i = 0; i + 32 <= img.length; i += 32) {
      if (img[i] === 0x53 && img[i + 1] === 0x55 && img[i + 2] === 0x42 && img[i + 11] === 0x10) {
        subOffset = i;
        break;
      }
    }
    expect(subOffset).toBeGreaterThanOrEqual(0);
    img[subOffset + 26] = 0xfe;
    img[subOffset + 27] = 0xff;

    const parsed = parse(img);
    expect(
      parsed.warnings.some((warning) =>
        /empty directory|out of range|invalid start cluster/i.test(warning.reason),
      ),
    ).toBe(true);
    expect(parsed.root.children).toHaveLength(1);
    expect(parsed.root.children[0]!.kind).toBe('dir');
    expect(parsed.root.children[0]!.name).toBe('SUB');
    expect(parsed.root.children[0]!.children).toEqual([]);
  });

  it('warns and truncates a chain that hits a free FAT entry mid-stream', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createFile('A.TXT', new Uint8Array(5000).fill(0x41))]),
      longFilenames: false,
    });

    const view = new DataView(img.buffer, img.byteOffset, img.byteLength);
    const sectorSize = view.getUint16(11, true);
    const fatStart = view.getUint16(14, true) * sectorSize;
    img[fatStart + 3] = 0x00;
    img[fatStart + 4] = 0x00;

    const parsed = parse(img);
    expect(parsed.warnings.some((warning) => /free FAT entry/i.test(warning.reason))).toBe(true);
    const entries = flatten(parsed.root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content.length).toBe(4096);
  });

  it('round-trips LFN round-trip through generate -> parse', () => {
    const source = createDir('root', [
      createFile('a_very_long_file_name.txt', new TextEncoder().encode('hello\n')),
      createFile('SHORT.TXT', new TextEncoder().encode('short\n')),
      createDir('Sub Folder', [createFile('inner_long.bin', new Uint8Array([9, 9, 9]))]),
    ]);
    const img = generate({ size: 524288, source });
    const { root } = parse(img);
    const names = flatten(root)
      .map((f) => f.path)
      .sort();
    expect(names).toEqual(
      ['short.txt', 'sub folder/inner_long.bin', 'a_very_long_file_name.txt'].sort(),
    );
  });

  it('round-trips a FAT32 image', () => {
    // 48 MiB image, 512-byte sectors, 1 sector / cluster. This is large
    // enough to stay above FatFs' FAT16 cluster-count boundary.
    const size = 48 * 1024 * 1024;
    const source = createDir('root', [
      createFile('README.TXT', new TextEncoder().encode('fat32 round-trip\n')),
      createFile('mixed_case_long_name.md', new TextEncoder().encode('markdown here\n')),
      createDir('SUBDIR', [
        createFile('NESTED.TXT', new Uint8Array([1, 2, 3, 4])),
        createFile('nested long filename.bin', new Uint8Array([9, 8, 7, 6, 5])),
      ]),
    ]);
    const img = generate({
      size,
      source,
      sectorSize: 512,
      sectorsPerCluster: 1,
      explicitFatType: 32,
    });
    const parsed = parse(img);
    expect(parsed.boot.fatType).toBe(32);
    expect(parsed.boot.rootClusterId).toBe(2);
    expect(parsed.warnings).toEqual([]);
    const entries = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('readme.txt');
    expect(paths).toContain('mixed_case_long_name.md');
    expect(paths).toContain('subdir/nested.txt');
    expect(paths).toContain('subdir/nested long filename.bin');
    const readme = entries.find((e) => e.path === 'readme.txt')!;
    expect(new TextDecoder().decode(readme.content)).toBe('fat32 round-trip\n');
    const nested = entries.find((e) => e.path === 'subdir/nested.txt')!;
    expect(Array.from(nested.content)).toEqual([1, 2, 3, 4]);
  });

  it('warns and recovers when a FAT12/16-style BPB exceeds the FAT32 cluster threshold', () => {
    const img = generate({
      size: 524288,
      source: createDir('root', [createFile('A.TXT', new Uint8Array(0))]),
      sectorSize: 4096,
    });
    const view = new DataView(img.buffer);
    view.setUint16(19, 0, true);
    view.setUint32(32, 76800, true);

    const warnings: ParseWarning[] = [];
    const parsed = parse(img, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(parsed.boot.fatType).toBe(16);
    expect(flatten(parsed.root).map((entry) => entry.path)).toEqual(['a.txt']);
    expect(warnings.some((warning) => /classify it as FAT32/i.test(warning.reason))).toBe(true);
  });

  it('warns when a FAT32-style BPB does not have enough data clusters for FAT32', () => {
    const img = generate({
      size: 48 * 1024 * 1024,
      source: createDir('root', [createFile('A.TXT', new Uint8Array([0x41]))]),
      sectorSize: 512,
      sectorsPerCluster: 1,
      explicitFatType: 32,
    });
    const view = new DataView(img.buffer, img.byteOffset, img.byteLength);
    view.setUint32(32, 1024, true);

    const parsed = parse(img);
    expect(parsed.boot.fatType).toBe(32);
    expect(
      parsed.warnings.some((warning) => /describes a FAT32-style volume/i.test(warning.reason)),
    ).toBe(true);
    expect(
      parsed.warnings.some((warning) => /classify it as FAT(12|16)/i.test(warning.reason)),
    ).toBe(true);
  });

  it('does not terminate FAT32 directories early when clusters span multiple sectors', () => {
    const source = createDir(
      'root',
      Array.from({ length: 40 }, (_, i) =>
        createFile(`F${String(i).padStart(2, '0')}.TXT`, new TextEncoder().encode(`${i}\n`)),
      ),
    );
    const img = generate({
      size: 96 * 1024 * 1024,
      source,
      sectorSize: 512,
      sectorsPerCluster: 2,
      explicitFatType: 32,
    });
    const parsed = parse(img);
    const paths = flatten(parsed.root)
      .map((entry) => entry.path)
      .sort();
    expect(paths).toHaveLength(40);
    expect(paths[0]).toBe('f00.txt');
    expect(paths[39]).toBe('f39.txt');
  });

  it('rejects an explicit FAT32 request when the image is too small for FatFs', () => {
    expect(() =>
      generate({
        size: 32 * 1024 * 1024,
        source: createDir('root', [createFile('A.TXT', new Uint8Array([0x41]))]),
        sectorSize: 512,
        sectorsPerCluster: 1,
        explicitFatType: 32,
      }),
    ).toThrow(/explicitFatType: 32 requires more than 65525 data clusters/i);
  });

  it('normalizes non-sector-aligned FAT12/16 root entry counts', () => {
    const img = generate({
      size: 512 * 1024,
      source: createDir('root', [createFile('A.TXT', new Uint8Array([0x41]))]),
      sectorSize: 512,
      rootEntryCount: 513,
    });
    const parsed = parse(img);
    expect(parsed.boot.rootEntryCount).toBe(528);
  });

  it('uses 0 for FAT12/16 root ".." when espIdfCompat is disabled', () => {
    const img = generate({
      size: 512 * 1024,
      source: createDir('root', [
        createDir('SUBDIR', [createFile('A.TXT', new Uint8Array([0x41]))]),
      ]),
      sectorSize: 512,
      espIdfCompat: false,
      longFilenames: false,
    });
    const view = new DataView(img.buffer, img.byteOffset, img.byteLength);
    const sectorSize = view.getUint16(11, true);
    const reserved = view.getUint16(14, true);
    const fatCount = img[16]!;
    const rootEntryCount = view.getUint16(17, true);
    const fatSectors = view.getUint16(22, true);
    const rootDirStart = (reserved + fatSectors * fatCount) * sectorSize;
    const subdirCluster = view.getUint16(rootDirStart + 26, true);
    const dataRegionStart = rootDirStart + rootEntryCount * 32;
    const subdirOffset = dataRegionStart + (subdirCluster - 2) * sectorSize;
    expect(view.getUint16(subdirOffset + 32 + 26, true)).toBe(0);
  });

  it('keeps FAT12/16 root ".." at ESP-IDF root marker when espIdfCompat is enabled', () => {
    const img = generate({
      size: 512 * 1024,
      source: createDir('root', [
        createDir('SUBDIR', [createFile('A.TXT', new Uint8Array([0x41]))]),
      ]),
      sectorSize: 512,
      espIdfCompat: true,
      longFilenames: false,
    });
    const view = new DataView(img.buffer, img.byteOffset, img.byteLength);
    const sectorSize = view.getUint16(11, true);
    const reserved = view.getUint16(14, true);
    const fatCount = img[16]!;
    const rootEntryCount = view.getUint16(17, true);
    const fatSectors = view.getUint16(22, true);
    const rootDirStart = (reserved + fatSectors * fatCount) * sectorSize;
    const subdirCluster = view.getUint16(rootDirStart + 26, true);
    const dataRegionStart = rootDirStart + rootEntryCount * 32;
    const subdirOffset = dataRegionStart + (subdirCluster - 2) * sectorSize;
    expect(view.getUint16(subdirOffset + 32 + 26, true)).toBe(1);
  });

  it('writes proper FAT32 BPB / FSInfo / backup boot sector', () => {
    const size = 48 * 1024 * 1024;
    const source = createDir('root', [createFile('A.TXT', new Uint8Array([0x41]))]);
    const img = generate({
      size,
      source,
      sectorSize: 512,
      sectorsPerCluster: 1,
      explicitFatType: 32,
    });
    const view = new DataView(img.buffer);
    // BPB_FATSz16 must be 0, BPB_RootEntCnt must be 0.
    expect(view.getUint16(22, true)).toBe(0);
    expect(view.getUint16(17, true)).toBe(0);
    // BPB_RootClus == 2.
    expect(view.getUint32(44, true)).toBe(2);
    // FS type string.
    const fsType = new TextDecoder().decode(img.subarray(82, 90)).trim();
    expect(fsType).toBe('FAT32');
    // FSInfo sector signatures.
    const fsInfo = 1 * 512;
    expect(view.getUint32(fsInfo, true)).toBe(0x41615252);
    expect(view.getUint32(fsInfo + 484, true)).toBe(0x61417272);
    expect(view.getUint32(fsInfo + 508, true) >>> 0).toBe(0xaa550000);
    // Backup boot sector at sector 6 mirrors byte 0..2 (JmpBoot).
    const bk = 6 * 512;
    expect(img[bk]).toBe(img[0]);
    expect(img[bk + 1]).toBe(img[1]);
    expect(img[bk + 510]).toBe(0x55);
    expect(img[bk + 511]).toBe(0xaa);
  });

  it('matches wl_fatfsgen.py output (perf mode, 8.3 names)', () => {
    const src = join(fixtures, 'fatfs_src');
    const source = createDir('fatfs_src', [
      createFile('HELLO.TXT', new Uint8Array(readFileSync(join(src, 'HELLO.TXT')))),
      createFile('README.MD', new Uint8Array(readFileSync(join(src, 'README.MD')))),
    ]);
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_wl.img')));

    // The inner FATFS boot sector lives one 4096-sector past the start (dummy
    // sector). Read BS_VolID (offset 39) and the WL device_id from the first
    // state sector so we can reproduce the golden bytes exactly.
    const partitionSize = golden.byteLength;
    const layout = computeWlLayout(partitionSize, 'perf');
    const volumeUuid = new DataView(golden.buffer).getUint32(WL_SECTOR_SIZE + 39, true);
    const wlStateTotal = layout.wlStateSectors * WL_SECTOR_SIZE;
    const tailStart = partitionSize - (2 * wlStateTotal + WL_SECTOR_SIZE);
    const deviceId = new DataView(golden.buffer).getUint32(tailStart + 28, true);

    const produced = generate({
      size: partitionSize,
      source,
      sectorSize: WL_SECTOR_SIZE,
      volumeUuid,
      wearLeveling: { deviceId },
      longFilenames: false,
    });
    expect(produced.byteLength).toBe(partitionSize);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 20) break;
    }
    expect(diffs, `diff at offsets ${diffs.slice(0, 10).join(',')}`).toEqual([]);
  });

  it('wraps current-IDF LFN output with wear leveling correctly', () => {
    const src = join(fixtures, 'fatfs_lfn');
    const source = createDir('fatfs_lfn', [
      createFile(
        'hello_long_name.txt',
        new Uint8Array(readFileSync(join(src, 'hello_long_name.txt'))),
      ),
      createFile('MixedCase.TXT', new Uint8Array(readFileSync(join(src, 'MixedCase.TXT')))),
      createFile('SHORT.TXT', new Uint8Array(readFileSync(join(src, 'SHORT.TXT')))),
    ]);
    const partitionSize = 512 * 1024;
    const produced = generate({
      size: partitionSize,
      source,
      sectorSize: WL_SECTOR_SIZE,
      volumeUuid: 0,
      wearLeveling: { deviceId: 0x12345678 },
      espIdfCompat: true,
    });
    expect(produced.byteLength).toBe(partitionSize);
    const parsed = parse(produced);
    const names = flatten(parsed.root)
      .map((f) => f.path)
      .sort();
    expect(names).toEqual(['hello_long_name.txt', 'mixedcase.txt', 'short.txt']);
  });

  it('auto-detects WL when wearLeveling is omitted, but false keeps plain parsing', () => {
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_wl.img')));
    const detected = parse(golden);
    expect(detected.root.children.map((c) => c.name).sort()).toEqual(['HELLO.TXT', 'README.MD']);
    expect(() => parse(golden, { wearLeveling: false })).toThrow(/boot signature/i);
  });

  it('parses a wl_fatfsgen.py image via parse({ wearLeveling: true })', () => {
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_wl.img')));
    const { root } = parse(golden, { wearLeveling: true });
    const names = root.children.map((c) => c.name).sort();
    expect(names).toEqual(['HELLO.TXT', 'README.MD']);
  });

  it('round-trips generate({ wearLeveling }) -> parse({ wearLeveling })', () => {
    const source = createDir('root', [
      createFile('HELLO.TXT', new TextEncoder().encode('hello\n')),
      createDir('SUB', [createFile('A.BIN', new Uint8Array([9, 8, 7]))]),
    ]);
    const partitionSize = 512 * 1024;
    const img = generate({
      size: partitionSize,
      source,
      sectorSize: WL_SECTOR_SIZE,
      wearLeveling: true,
    });
    expect(img.byteLength).toBe(partitionSize);

    // Validate WL config sector CRC integrity by re-parsing its state header.
    const layout = computeWlLayout(partitionSize, 'perf');
    const wlStateTotal = layout.wlStateSectors * WL_SECTOR_SIZE;
    const tailStart = partitionSize - (2 * wlStateTotal + WL_SECTOR_SIZE);
    const header = parseStateHeader(img.subarray(tailStart, tailStart + WL_STATE_HEADER_SIZE));
    expect(header.moveCount).toBe(0);
    expect(header.blockSize).toBe(WL_SECTOR_SIZE);
    expect(header.deviceId).toBe(0); // deterministic default

    const parsed = parse(img, { wearLeveling: true });
    const entries = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries.map((e) => e.path)).toEqual(['hello.txt', 'sub/a.bin']);
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('hello\n');
    expect(Array.from(entries[1]!.content)).toEqual([9, 8, 7]);

    // removeWearLeveling returns the plain FATFS that parse() can consume.
    const plain = removeWearLeveling(img);
    expect(plain.byteLength).toBe(layout.plainImageSize);
    const parsedPlain = parse(plain);
    expect(parsedPlain.root.children.map((c) => c.name).sort()).toEqual(['hello.txt', 'sub']);
  });

  it('wrapWearLeveling standalone produces the same bytes as generate({ wearLeveling })', () => {
    const source = createDir('root', [createFile('A.TXT', new TextEncoder().encode('hi\n'))]);
    const partitionSize = 256 * 1024;
    const combined = generate({
      size: partitionSize,
      source,
      sectorSize: WL_SECTOR_SIZE,
      wearLeveling: { deviceId: 0xdeadbeef },
    });
    const layout = computeWlLayout(partitionSize, 'perf');
    const plain = generate({ size: layout.plainImageSize, source, sectorSize: WL_SECTOR_SIZE });
    const wrapped = wrapWearLeveling(plain, partitionSize, { deviceId: 0xdeadbeef });
    expect(wrapped.byteLength).toBe(combined.byteLength);
    for (let i = 0; i < wrapped.byteLength; i++) {
      if (wrapped[i] !== combined[i]) throw new Error(`differ at ${i}`);
    }
  });

  it('round-trips a 512-byte-sector WL image in perf mode', () => {
    const source = createDir('root', [
      createFile('HELLO.TXT', new TextEncoder().encode('hello\n')),
      createDir('SUB', [createFile('A.BIN', new Uint8Array([1, 2, 3, 4]))]),
    ]);
    const partitionSize = 512 * 1024;
    const img = generate({
      size: partitionSize,
      source,
      sectorSize: WL_FAT_SECTOR_SIZE_512,
      wearLeveling: { mode: 'perf', deviceId: 0x12345678 },
    });

    const layout = computeWlLayout(partitionSize, 'perf', WL_FAT_SECTOR_SIZE_512);
    expect(removeWearLeveling(img, 'perf').byteLength).toBe(layout.plainImageSize);

    const parsed = parse(img, { wearLeveling: true });
    const entries = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries.map((e) => e.path)).toEqual(['hello.txt', 'sub/a.bin']);
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('hello\n');
    expect(Array.from(entries[1]!.content)).toEqual([1, 2, 3, 4]);
  });

  it('round-trips a 512-byte-sector WL image in safe mode', () => {
    const source = createDir('root', [
      createFile('SAFE.TXT', new TextEncoder().encode('safe\n')),
      createFile('DATA.BIN', new Uint8Array([9, 8, 7])),
    ]);
    const partitionSize = 512 * 1024;
    const img = generate({
      size: partitionSize,
      source,
      sectorSize: WL_FAT_SECTOR_SIZE_512,
      wearLeveling: { mode: 'safe', deviceId: 0xabcdef01 },
    });

    const layout = computeWlLayout(partitionSize, 'safe', WL_FAT_SECTOR_SIZE_512);
    const plain = removeWearLeveling(img, 'safe');
    expect(plain.byteLength).toBe(layout.plainImageSize);

    const parsed = parse(img, { wearLeveling: true });
    const entries = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries.map((e) => e.path)).toEqual(['data.bin', 'safe.txt']);
    expect(Array.from(entries[0]!.content)).toEqual([9, 8, 7]);
    expect(new TextDecoder().decode(entries[1]!.content)).toBe('safe\n');
  });

  it('lays out 512-byte-sector WL metadata at the C runtime offsets', () => {
    const source = createDir('root', [createFile('META.TXT', new TextEncoder().encode('meta\n'))]);
    const partitionSize = 512 * 1024;
    const img = generate({
      size: partitionSize,
      source,
      sectorSize: WL_FAT_SECTOR_SIZE_512,
      wearLeveling: { mode: 'safe', deviceId: 0x13572468 },
    });

    const layout = computeWlLayout(partitionSize, 'safe', WL_FAT_SECTOR_SIZE_512);
    const dummySize = WL_SECTOR_SIZE;
    const plainStart = dummySize;
    const plainEnd = plainStart + layout.plainImageSize;
    const safeRegionStart = plainEnd;
    const state1Start = partitionSize - (layout.stateSize * 2 + WL_SECTOR_SIZE);
    const state2Start = state1Start + layout.stateSize;
    const configStart = state2Start + layout.stateSize;

    expect(safeRegionStart).toBe(state1Start - 2 * WL_SECTOR_SIZE);
    expect(configStart + WL_SECTOR_SIZE).toBe(partitionSize);

    for (let i = safeRegionStart; i < state1Start; i++) {
      expect(img[i]).toBe(0xff);
    }

    const innerBoot = new DataView(img.buffer, img.byteOffset + plainStart, 64);
    expect(innerBoot.getUint16(11, true)).toBe(512);

    const state1 = parseStateHeader(img.subarray(state1Start, state1Start + WL_STATE_HEADER_SIZE));
    const state2 = parseStateHeader(img.subarray(state2Start, state2Start + WL_STATE_HEADER_SIZE));
    expect(state1.deviceId).toBe(0x13572468);
    expect(state1.blockSize).toBe(WL_SECTOR_SIZE);
    expect(state1.maxPos).toBe(1 + layout.flashSize / WL_SECTOR_SIZE);
    expect(state2.deviceId).toBe(0x13572468);

    const cfg = new DataView(img.buffer, img.byteOffset + configStart, 48);
    expect(cfg.getUint32(4, true)).toBe(partitionSize);
    expect(cfg.getUint32(8, true)).toBe(WL_SECTOR_SIZE);
    expect(cfg.getUint32(12, true)).toBe(WL_SECTOR_SIZE);
  });

  it('round-trips a generated image', () => {
    const source = createDir('root', [
      createFile('A.TXT', new TextEncoder().encode('hello world\n')),
      createDir('D', [createFile('B.BIN', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))]),
    ]);
    const img = generate({ size: 262144, source });
    const parsed = parse(img);
    const entries = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'd/b.bin']);
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('hello world\n');
    expect(Array.from(entries[1]!.content)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
