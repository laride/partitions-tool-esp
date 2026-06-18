import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDir, createFile } from '../src/common/virtual-fs.js';
import type { ParseWarning } from '../src/common/diagnostics.js';
import { generate, parse, buildConfig } from '../src/spiffs/index.js';
import {
  log2,
  SPIFFS_PH_FLAG_USED_FINAL,
  SPIFFS_PH_FLAG_USED_FINAL_INDEX,
  writeUint,
} from '../src/spiffs/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

describe('SPIFFS - generate', () => {
  it('matches spiffsgen.py output byte-for-byte', () => {
    // The fixture was produced with `os.walk`, which on this filesystem
    // returns files in filesystem iteration order (`greek`, `long`, `hello`).
    const src = join(fixtures, 'spiffs_src');
    const source = createDir('root', [
      createFile('greek.txt', new Uint8Array(readFileSync(join(src, 'greek.txt')))),
      createFile('long.txt', new Uint8Array(readFileSync(join(src, 'long.txt')))),
      createFile('hello.txt', new Uint8Array(readFileSync(join(src, 'hello.txt')))),
    ]);
    const golden = new Uint8Array(readFileSync(join(fixtures, 'spiffs_basic.bin')));
    const produced = generate({ imageSize: 65536, source });
    expect(produced.byteLength).toBe(golden.byteLength);
    const diffs: number[] = [];
    for (let i = 0; i < produced.byteLength; i++) {
      if (produced[i] !== golden[i]) diffs.push(i);
      if (diffs.length > 20) break;
    }
    expect(diffs, `diff at ${diffs.join(',')}`).toEqual([]);
  });
});

describe('SPIFFS - parse', () => {
  it('round-trips our own generator output', () => {
    const contents = {
      'hello.txt': new TextEncoder().encode('hello world\n'),
      'greek.txt': new TextEncoder().encode('alpha\nbeta\ngamma\n'),
      'long.txt': new TextEncoder().encode('abcd'.repeat(200) + '\n'),
    };
    const source = createDir('root', [
      createFile('hello.txt', contents['hello.txt']),
      createFile('greek.txt', contents['greek.txt']),
      createFile('long.txt', contents['long.txt']),
    ]);
    const image = generate({ imageSize: 65536, source });

    const parsed = parse(image);
    expect(parsed.files.map((f) => f.path).sort()).toEqual([
      '/greek.txt',
      '/hello.txt',
      '/long.txt',
    ]);
    for (const file of parsed.files) {
      const name = file.path.replace(/^\//, '') as keyof typeof contents;
      expect(new TextDecoder().decode(file.content)).toBe(new TextDecoder().decode(contents[name]));
    }
  });

  it('round-trips UTF-8 file names using byte-based object-name semantics', () => {
    const source = createDir('root', [
      createFile('é.txt', new TextEncoder().encode('hello\n')),
      createDir('目录', [createFile('内文.txt', new TextEncoder().encode('world\n'))]),
    ]);

    const image = generate({ imageSize: 65536, source });
    const parsed = parse(image);
    const byName = new Map(parsed.files.map((file) => [file.path, file] as const));

    expect(new TextDecoder().decode(byName.get('/é.txt')!.content)).toBe('hello\n');
    expect(new TextDecoder().decode(byName.get('/目录/内文.txt')!.content)).toBe('world\n');
  });

  it('parses spiffsgen.py golden image', () => {
    const golden = new Uint8Array(readFileSync(join(fixtures, 'spiffs_basic.bin')));
    const parsed = parse(golden);
    const byName = new Map(parsed.files.map((f) => [f.path, f] as const));
    expect(byName.get('/hello.txt')?.content.byteLength).toBe(12);
    expect(byName.get('/greek.txt')?.size).toBe(17);
    expect(byName.get('/long.txt')?.size).toBe(801);
    expect(new TextDecoder().decode(byName.get('/greek.txt')!.content)).toBe(
      'alpha\nbeta\ngamma\n',
    );
  });

  it('logs a warning when index page references a corrupted data page', () => {
    const content = new TextEncoder().encode('hello world\n');
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('hello.txt', content)]),
    });
    const config = buildConfig();

    // Corrupt the first data page's flags so it fails validation
    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        const isIndex = (objIdRaw & 0x8000) !== 0;
        if (
          objIdRaw !== 0xffff &&
          objIdRaw !== 0 &&
          !isIndex &&
          flags === SPIFFS_PH_FLAG_USED_FINAL
        ) {
          view.setUint8(4, 0xff);
          bix = image.length;
          break;
        }
      }
    }

    const warnings: ParseWarning[] = [];
    const parsed = parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(parsed.files).toHaveLength(1);
    expect(parsed.warnings.some((w) => /mismatched header/.test(w.reason))).toBe(true);
    expect(warnings).toEqual(parsed.warnings);
  });

  it('uses index page table (not data page spanIx) to locate content', () => {
    const content = new TextEncoder().encode('AAAA');
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('test.txt', content)]),
    });
    const config = buildConfig();
    const pageShift = log2(config.pageSize);

    // Find the index page (header) and swap the page pointer to a different page
    // filled with 'B's. The parser should follow the index table pointer.
    let indexPageOff = -1;
    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        if (
          objIdRaw !== 0xffff &&
          (objIdRaw & 0x8000) !== 0 &&
          flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX
        ) {
          indexPageOff = off;
          bix = image.length;
          break;
        }
      }
    }
    expect(indexPageOff).toBeGreaterThan(-1);

    // Read original page pointer (first entry after the index header)
    const ixView = new DataView(image.buffer, image.byteOffset + indexPageOff, config.pageSize);
    const ptrOffset = config.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED;
    const origPageIx = ixView.getUint16(ptrOffset, true);

    // Find a free page to write fake data into
    let freePageOff = -1;
    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        if (objIdRaw === 0xffff && off !== indexPageOff && off !== origPageIx << pageShift) {
          freePageOff = off;
          bix = image.length;
          break;
        }
      }
    }
    expect(freePageOff).toBeGreaterThan(-1);

    // Write a fake data page with objId=1, spanIx=0, flags=USED_FINAL, content='BBBB'
    const fakeView = new DataView(image.buffer, image.byteOffset + freePageOff, config.pageSize);
    fakeView.setUint16(0, 1, true); // objId (no MSB = data page)
    fakeView.setUint16(2, 0, true); // spanIx
    fakeView.setUint8(4, SPIFFS_PH_FLAG_USED_FINAL);
    const fakeContent = new TextEncoder().encode('BBBB');
    new Uint8Array(
      image.buffer,
      image.byteOffset + freePageOff + config.OBJ_DATA_PAGE_HEADER_LEN,
      4,
    ).set(fakeContent);

    // Point the index page's first entry to our fake page
    const fakePageIx = freePageOff >>> pageShift;
    ixView.setUint16(ptrOffset, fakePageIx, true);
    const fakeBlockOffset = Math.floor(freePageOff / config.blockSize) * config.blockSize;
    const fakePixInBlock = (fakePageIx % config.PAGES_PER_BLOCK) - config.OBJ_LU_PAGES_PER_BLOCK;
    new DataView(
      image.buffer,
      image.byteOffset + fakeBlockOffset + fakePixInBlock * config.objIdLen,
      config.objIdLen,
    ).setUint16(0, 1, true);

    // Parse should follow the index table and return 'BBBB', not the original 'AAAA'
    const parsed = parse(image);
    expect(parsed.files).toHaveLength(1);
    expect(new TextDecoder().decode(parsed.files[0]!.content)).toBe('BBBB');
  });

  it('preserves SPIFFS data-span mapping when an intermediate index page is missing', () => {
    const config = buildConfig();
    const headLen = config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM;
    const bodyLen = config.OBJ_INDEX_PAGES_OBJ_IDS_LIM;
    const totalPagesNeeded = headLen + bodyLen + 2;
    const content = new Uint8Array(totalPagesNeeded * config.OBJ_DATA_PAGE_CONTENT_LEN);
    content.fill(0x41, 0, headLen * config.OBJ_DATA_PAGE_CONTENT_LEN);
    content.fill(
      0x42,
      headLen * config.OBJ_DATA_PAGE_CONTENT_LEN,
      (headLen + bodyLen) * config.OBJ_DATA_PAGE_CONTENT_LEN,
    );
    content.fill(0x43, (headLen + bodyLen) * config.OBJ_DATA_PAGE_CONTENT_LEN, content.length);

    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('big.bin', content)]),
    });

    let removed = false;
    for (let bix = 0; bix < image.length / config.blockSize && !removed; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const spanIx = view.getUint16(2, true);
        const flags = view.getUint8(4);
        const isIndex = (objIdRaw & 0x8000) !== 0;
        if (
          objIdRaw !== 0xffff &&
          isIndex &&
          flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX &&
          spanIx === 1
        ) {
          view.setUint8(4, 0xff);
          removed = true;
          break;
        }
      }
    }
    expect(removed).toBe(true);

    const warnings: ParseWarning[] = [];
    const parsed = parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(parsed.files).toHaveLength(1);
    expect(warnings.some((warning) => /index page span 1 is missing/.test(warning.reason))).toBe(
      true,
    );
    const parsedContent = parsed.files[0]!.content;
    expect(parsedContent[0]).toBe(0x41);
    expect(parsedContent[headLen * config.OBJ_DATA_PAGE_CONTENT_LEN]).toBe(0x00);
    expect(parsedContent[(headLen + bodyLen) * config.OBJ_DATA_PAGE_CONTENT_LEN]).toBe(0x43);
  });

  it('warns on invalid UTF-8 in file name', () => {
    const content = new TextEncoder().encode('test');
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('hello.txt', content)]),
    });
    const config = buildConfig();

    // Find the index page and corrupt the filename bytes
    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        if (
          objIdRaw !== 0xffff &&
          (objIdRaw & 0x8000) !== 0 &&
          flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX
        ) {
          // Name starts after OBJ_DATA_PAGE_HEADER_LEN_ALIGNED + IX_SIZE_LEN + IX_OBJ_TYPE_LEN
          const nameStart = off + config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED + 4 + 1;
          // Replace first byte '/' with 0xFF (invalid UTF-8 leading byte)
          image[nameStart] = 0xff;
          bix = image.length;
          break;
        }
      }
    }

    const warnings: ParseWarning[] = [];
    const parsed = parse(image, {
      onWarning(w) {
        warnings.push(w);
      },
    });
    expect(parsed.files).toHaveLength(1);
    expect(warnings.some((w) => /invalid UTF-8/.test(w.reason))).toBe(true);
  });

  it('warns when file name is not NUL-terminated', () => {
    const name = 'a'.repeat(30); // on-flash path '/'+30 chars = 31 bytes, still generated by our writer
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile(name, new TextEncoder().encode('hello'))]),
    });
    const config = buildConfig();

    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        if (
          objIdRaw !== 0xffff &&
          (objIdRaw & 0x8000) !== 0 &&
          flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX
        ) {
          const nameStart = config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED + 4 + 1;
          const nameEnd = nameStart + config.objNameLen;
          image.fill(0x41, off + nameStart, off + nameEnd);

          const warnings: ParseWarning[] = [];
          const parsed = parse(image, {
            onWarning(warning) {
              warnings.push(warning);
            },
          });

          expect(parsed.files).toHaveLength(1);
          expect(parsed.files[0]!.path).toBe('A'.repeat(config.objNameLen));
          expect(warnings.some((warning) => /not NUL-terminated/.test(warning.reason))).toBe(true);
          return;
        }
      }
    }

    throw new Error('failed to locate SPIFFS index page');
  });

  it('throws when header size exceeds what the image can address', () => {
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello'))]),
    });
    const config = buildConfig();

    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        if (
          objIdRaw !== 0xffff &&
          (objIdRaw & 0x8000) !== 0 &&
          flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX
        ) {
          view.setUint32(config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED, 0xffffffff, true);
          expect(() => parse(image)).toThrow(/declares impossible size/i);
          return;
        }
      }
    }

    throw new Error('failed to locate SPIFFS index page');
  });

  it('throws when parse metaLen does not match the image layout', () => {
    const image = generate({
      imageSize: 65536,
      metaLen: 0,
      source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello'))]),
    });

    expect(() => parse(image)).toThrow(/parse options likely do not match the image layout/i);
    expect(parse(image, { metaLen: 0 }).files).toHaveLength(1);
  });

  it('throws when parse alignedObjIxTables does not match the image layout', () => {
    const image = generate({
      imageSize: 65536,
      objNameLen: 31,
      metaLen: 5,
      alignedObjIxTables: true,
      source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello'))]),
    });

    expect(() => parse(image, { objNameLen: 31, metaLen: 5 })).toThrow(
      /parse options likely do not match the image layout/i,
    );
    expect(
      parse(image, {
        objNameLen: 31,
        metaLen: 5,
        alignedObjIxTables: true,
      }).files,
    ).toHaveLength(1);
  });

  it('warns when object type is not SPIFFS_TYPE_FILE', () => {
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello'))]),
    });
    const config = buildConfig();

    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        if (
          objIdRaw !== 0xffff &&
          (objIdRaw & 0x8000) !== 0 &&
          flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX
        ) {
          const objTypeOffset = config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED + 4;
          view.setUint8(objTypeOffset, 0x7f);

          const warnings: ParseWarning[] = [];
          const parsed = parse(image, {
            onWarning(warning) {
              warnings.push(warning);
            },
          });

          expect(parsed.files).toHaveLength(1);
          expect(warnings.some((warning) => /unexpected type 127/.test(warning.reason))).toBe(true);
          return;
        }
      }
    }

    throw new Error('failed to locate SPIFFS index page');
  });

  it('ignores index pages that are no longer live in lookup', () => {
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello'))]),
    });
    const config = buildConfig();

    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        if (
          objIdRaw !== 0xffff &&
          (objIdRaw & 0x8000) !== 0 &&
          flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX
        ) {
          const luEntry = pix - config.OBJ_LU_PAGES_PER_BLOCK;
          const luOffset = blockOffset + luEntry * config.objIdLen;
          new DataView(image.buffer, image.byteOffset + luOffset, config.objIdLen).setUint16(
            0,
            0xffff,
            true,
          );

          const parsed = parse(image);
          expect(parsed.files).toEqual([]);
          return;
        }
      }
    }

    throw new Error('failed to locate SPIFFS index page');
  });

  it('treats data pages missing from lookup as content gaps', () => {
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello'))]),
    });
    const config = buildConfig();

    for (let bix = 0; bix < image.length / config.blockSize; bix++) {
      const blockOffset = bix * config.blockSize;
      for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
        const off = blockOffset + pix * config.pageSize;
        const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
        const objIdRaw = view.getUint16(0, true);
        const flags = view.getUint8(4);
        if (
          objIdRaw !== 0xffff &&
          (objIdRaw & 0x8000) === 0 &&
          flags === SPIFFS_PH_FLAG_USED_FINAL
        ) {
          const luEntry = pix - config.OBJ_LU_PAGES_PER_BLOCK;
          const luOffset = blockOffset + luEntry * config.objIdLen;
          new DataView(image.buffer, image.byteOffset + luOffset, config.objIdLen).setUint16(
            0,
            0,
            true,
          );

          const warnings: ParseWarning[] = [];
          const parsed = parse(image, {
            onWarning(warning) {
              warnings.push(warning);
            },
          });

          expect(parsed.files).toHaveLength(1);
          expect(new TextDecoder().decode(parsed.files[0]!.content)).toBe('\0\0\0\0\0');
          expect(warnings.some((warning) => /not live in object lookup/.test(warning.reason))).toBe(
            true,
          );
          return;
        }
      }
    }

    throw new Error('failed to locate SPIFFS data page');
  });
});

describe('SPIFFS - writer edge cases', () => {
  it('computes lookup pages per block like C/new spiffsgen.py for custom geometry', () => {
    const config = buildConfig({ blockSize: 256 * 129, pageSize: 256 });
    expect(config.PAGES_PER_BLOCK).toBe(129);
    expect(config.OBJ_LU_PAGES_PER_BLOCK).toBe(1);
  });

  it('throws on imageSize not aligned to blockSize', () => {
    const source = createDir('root', [createFile('a.txt', new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 5000, source, blockSize: 4096 })).toThrow(
      /multiple of block size/,
    );
  });

  it('throws on file name too long (byte length)', () => {
    const longName = 'a'.repeat(256) + '.txt';
    const source = createDir('root', [createFile(longName, new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 65536, source })).toThrow(/too long/);
  });

  it('throws when file name contains a NUL byte', () => {
    const source = createDir('root', [createFile(`bad\u0000name.txt`, new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 65536, source })).toThrow(/contains NUL byte/);
  });

  it('throws when file name byte length equals objNameLen to preserve IDF runtime compatibility', () => {
    // ESP-IDF master fixes the historical spiffsgen.py/runtime mismatch here,
    // and we keep matching the runtime requirement for a trailing NUL.
    const name = 'a'.repeat(30); // "/" + 30 = 31 bytes which is fine
    const exactFitName = 'a'.repeat(31); // "/" + 31 = 32 bytes => no room for NUL
    const source1 = createDir('root', [createFile(name, new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 65536, source: source1 })).not.toThrow();
    const source2 = createDir('root', [createFile(exactFitName, new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 65536, source: source2 })).toThrow(/too long/);
  });

  it('rejects geometries that cannot fit an object index header', () => {
    const source = createDir('root', [createFile('a.txt', new Uint8Array([1]))]);
    expect(() =>
      generate({
        imageSize: 4096,
        source,
        pageSize: 32,
        blockSize: 4096,
        useMagic: false,
        useMagicLength: false,
      }),
    ).toThrow(/too small/);
  });

  it('rejects geometries where lookup pages cannot store SPIFFS magic', () => {
    const source = createDir('root', [createFile('a.txt', new Uint8Array([1]))]);
    expect(() =>
      generate({
        imageSize: 8192,
        source,
        pageSize: 128,
        blockSize: 8192,
        useMagic: true,
        useMagicLength: true,
      }),
    ).toThrow(/no room for SPIFFS magic/);
  });

  it('rejects non-power-of-two page sizes', () => {
    const source = createDir('root', [createFile('a.txt', new Uint8Array([1]))]);
    expect(() =>
      generate({
        imageSize: 65536,
        source,
        pageSize: 384,
        blockSize: 384 * 16,
      }),
    ).toThrow(/power of two/);
  });

  it('derives index entry capacity from page_ix width like ESP-IDF master', () => {
    const config = buildConfig({ pageSize: 256, blockSize: 4096 });
    expect(config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM).toBe(
      Math.floor((config.pageSize - config.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED) / config.pageIxLen),
    );
    expect(config.OBJ_INDEX_PAGES_OBJ_IDS_LIM).toBe(
      Math.floor((config.pageSize - config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED) / config.pageIxLen),
    );
  });

  it('handles large file spanning multiple blocks', () => {
    const imageSize = 4096 * 4;
    const blockSize = 4096;
    const pageSize = 256;
    const bigContent = new Uint8Array(2000).fill(0x42);
    const source = createDir('root', [createFile('big.txt', bigContent)]);
    const image = generate({ imageSize, source, blockSize, pageSize });
    expect(image.byteLength).toBe(imageSize);
    const parsed = parse(image, { blockSize, pageSize });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.path).toBe('/big.txt');
    expect(parsed.files[0]!.content).toEqual(bigContent);
  });

  it('throws SpiffsFull when image is too small for content', () => {
    const imageSize = 4096;
    const blockSize = 4096;
    const pageSize = 256;
    const bigContent = new Uint8Array(4000).fill(0xab);
    const source = createDir('root', [createFile('huge.txt', bigContent)]);
    expect(() => generate({ imageSize, source, blockSize, pageSize })).toThrow(/exceeded/);
  });

  it('rejects images that would exhaust the usable object-id space', () => {
    const config = buildConfig();
    const fileCount = config.MAX_OBJ_ID + 1;
    const source = createDir(
      'root',
      Array.from({ length: fileCount }, (_, i) =>
        createFile(`f${i.toString().padStart(5, '0')}`, new Uint8Array(0)),
      ),
    );
    const blocksNeeded = Math.ceil(fileCount / config.OBJ_USABLE_PAGES_PER_BLOCK);
    const imageSize = blocksNeeded * config.blockSize;

    expect(() => generate({ imageSize, source })).toThrow(/object id space exhausted/);
  });

  it('fills default metadata bytes with 0xff like the SPIFFS C runtime', () => {
    const image = generate({
      imageSize: 65536,
      source: createDir('root', [createFile('meta.txt', new Uint8Array([1, 2, 3]))]),
    });
    const config = buildConfig();
    const metaStart = config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED + 4 + 1 + config.objNameLen;
    const firstIndexPageOffset = config.OBJ_LU_PAGES_PER_BLOCK * config.pageSize;
    const meta = image.subarray(
      firstIndexPageOffset + metaStart,
      firstIndexPageOffset + metaStart + config.metaLen,
    );

    expect([...meta]).toEqual(Array.from({ length: config.metaLen }, () => 0xff));
  });
});

describe('SPIFFS - fixed-width integer encoding', () => {
  it('rejects values that do not fit instead of truncating them', () => {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);

    expect(() => writeUint(view, 0, 0x1_0000, 2, 'little')).toThrow(/does not fit/);
    expect(() => writeUint(view, 0, -1, 2, 'little')).toThrow(/does not fit/);
    expect(() => writeUint(view, 0, 1.5, 2, 'little')).toThrow(/finite integer/);
    expect(() => writeUint(view, 0, 0x1_0000_0000, 4, 'little')).toThrow(/does not fit/);
    expect(() => writeUint(view, 0, 1n << 64n, 8, 'little')).toThrow(/does not fit/);
  });

  it('preserves in-range values for all supported widths', () => {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);

    writeUint(view, 0, 0xff, 1, 'little');
    writeUint(view, 1, 0xabcd, 2, 'little');
    writeUint(view, 3, 0x12345678, 4, 'big');
    writeUint(view, 7, 0x1234567890abcdefn, 8, 'little');

    expect(view.getUint8(0)).toBe(0xff);
    expect(view.getUint16(1, true)).toBe(0xabcd);
    expect(view.getUint32(3, false)).toBe(0x12345678);
    expect(view.getBigUint64(7, true)).toBe(0x1234567890abcdefn);
  });
});
