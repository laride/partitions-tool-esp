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
  WL_STATE_HEADER_SIZE,
} from '../src/fatfs/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

describe('FatFS - generate', () => {
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

    const produced = generate({ size: golden.byteLength, source, volumeUuid });
    expect(produced.byteLength).toBe(golden.byteLength);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 40) break;
    }
    expect(diffs, `diff at offsets ${diffs.slice(0, 20).join(',')}`).toEqual([]);
  });

  it('matches fatfsgen.py --long_name_support byte-for-byte', () => {
    const src = join(fixtures, 'fatfs_lfn');
    const source = createDir('fatfs_lfn', [
      createFile(
        'hello_long_name.txt',
        new Uint8Array(readFileSync(join(src, 'hello_long_name.txt'))),
      ),
      createFile('MixedCase.TXT', new Uint8Array(readFileSync(join(src, 'MixedCase.TXT')))),
      createFile('SHORT.TXT', new Uint8Array(readFileSync(join(src, 'SHORT.TXT')))),
    ]);
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_lfn.img')));
    const volumeUuid = new DataView(golden.buffer).getUint32(39, true);
    const produced = generate({ size: golden.byteLength, source, volumeUuid });
    expect(produced.byteLength).toBe(golden.byteLength);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 40) break;
    }
    expect(diffs, `diff at offsets ${diffs.slice(0, 20).join(',')}`).toEqual([]);
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
    const produced = generate({ size: golden.byteLength, source, volumeUuid });
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
    const { boot, root } = parse(golden);
    expect(boot.fatType).toBe(12);
    expect(boot.volumeLabel).toBe('Espressif');
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
    expect(names).toEqual(['SHORT.TXT', 'hello_long_name.txt', 'mixedcase.txt']);
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
      ['SHORT.TXT', 'sub folder/inner_long.bin', 'a_very_long_file_name.txt'].sort(),
    );
  });

  it('round-trips a FAT32 image', () => {
    // 32 MiB image, 512-byte sectors, 1 sector / cluster.
    const size = 32 * 1024 * 1024;
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
    const entries = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('README.TXT');
    expect(paths).toContain('mixed_case_long_name.md');
    expect(paths).toContain('SUBDIR/NESTED.TXT');
    expect(paths).toContain('SUBDIR/nested long filename.bin');
    const readme = entries.find((e) => e.path === 'README.TXT')!;
    expect(new TextDecoder().decode(readme.content)).toBe('fat32 round-trip\n');
    const nested = entries.find((e) => e.path === 'SUBDIR/NESTED.TXT')!;
    expect(Array.from(nested.content)).toEqual([1, 2, 3, 4]);
  });

  it('writes proper FAT32 BPB / FSInfo / backup boot sector', () => {
    const size = 32 * 1024 * 1024;
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
    });
    expect(produced.byteLength).toBe(partitionSize);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 20) break;
    }
    expect(diffs, `diff at offsets ${diffs.slice(0, 10).join(',')}`).toEqual([]);
  });

  it('matches wl_fatfsgen.py output with LFN', () => {
    const src = join(fixtures, 'fatfs_lfn');
    const source = createDir('fatfs_lfn', [
      createFile(
        'hello_long_name.txt',
        new Uint8Array(readFileSync(join(src, 'hello_long_name.txt'))),
      ),
      createFile('MixedCase.TXT', new Uint8Array(readFileSync(join(src, 'MixedCase.TXT')))),
      createFile('SHORT.TXT', new Uint8Array(readFileSync(join(src, 'SHORT.TXT')))),
    ]);
    const golden = new Uint8Array(readFileSync(join(fixtures, 'fatfs_wl_lfn.img')));
    const partitionSize = golden.byteLength;
    const layout = computeWlLayout(partitionSize, 'perf');
    const volumeUuid = new DataView(golden.buffer).getUint32(WL_SECTOR_SIZE + 39, true);
    const tailStart = partitionSize - (2 * layout.wlStateSectors * WL_SECTOR_SIZE + WL_SECTOR_SIZE);
    const deviceId = new DataView(golden.buffer).getUint32(tailStart + 28, true);
    const produced = generate({
      size: partitionSize,
      source,
      sectorSize: WL_SECTOR_SIZE,
      volumeUuid,
      wearLeveling: { deviceId },
    });
    expect(produced.byteLength).toBe(partitionSize);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 20) break;
    }
    expect(diffs, `diff at offsets ${diffs.slice(0, 10).join(',')}`).toEqual([]);
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
    expect(entries.map((e) => e.path)).toEqual(['HELLO.TXT', 'SUB/A.BIN']);
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('hello\n');
    expect(Array.from(entries[1]!.content)).toEqual([9, 8, 7]);

    // removeWearLeveling returns the plain FATFS that parse() can consume.
    const plain = removeWearLeveling(img);
    expect(plain.byteLength).toBe(layout.plainImageSize);
    const parsedPlain = parse(plain);
    expect(parsedPlain.root.children.map((c) => c.name).sort()).toEqual(['HELLO.TXT', 'SUB']);
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

  it('round-trips a generated image', () => {
    const source = createDir('root', [
      createFile('A.TXT', new TextEncoder().encode('hello world\n')),
      createDir('D', [createFile('B.BIN', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))]),
    ]);
    const img = generate({ size: 262144, source });
    const parsed = parse(img);
    const entries = flatten(parsed.root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries.map((e) => e.path)).toEqual(['A.TXT', 'D/B.BIN']);
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('hello world\n');
    expect(Array.from(entries[1]!.content)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
