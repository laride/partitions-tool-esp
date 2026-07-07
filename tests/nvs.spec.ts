import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32Nvs } from '../src/common/crc32.js';
import type { ParseWarning } from '../src/common/diagnostics.js';
import { generate, parse, parseCSV, NvsBuilder, fromObject } from '../src/nvs/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

describe('NVS - basic golden fixture', () => {
  it.each(['nvs_basic', 'nvs_multipage'])(
    'matches esp_idf_nvs_partition_gen output byte-for-byte (%s)',
    (name) => {
      const csv = readFileSync(join(fixtures, `${name}.csv`), 'utf8');
      const golden = new Uint8Array(readFileSync(join(fixtures, `${name}.bin`)));
      const entries = parseCSV(csv);
      const produced = generate(entries, { size: golden.byteLength, version: 2 });
      expect(produced.byteLength).toBe(golden.byteLength);
      const diff: number[] = [];
      for (let i = 0; i < produced.byteLength; i++) {
        if (produced[i] !== golden[i]) diff.push(i);
        if (diff.length > 10) break;
      }
      expect(diff, `diff at offsets ${diff.join(',')}`).toEqual([]);
    },
  );
});

describe('NVS - round-trip parse', () => {
  it('parses our own generated binary back to meaningful entries', () => {
    const csv = readFileSync(join(fixtures, 'nvs_basic.csv'), 'utf8');
    const entries = parseCSV(csv);
    const produced = generate(entries, { size: 0x4000, version: 2 });
    const dump = parse(produced);

    expect(dump.pages.length).toBe(4);
    // First page must be Active (last used page) or Full (filled pages).
    const active = dump.pages.find((p) => p.header.status === 'Active');
    expect(active).toBeDefined();

    // Crc correctness for all non-empty, written entries.
    for (const page of dump.pages) {
      if (page.header.status === 'Empty') continue;
      expect(page.header.crc.ok).toBe(true);
      for (const entry of page.entries) {
        if (entry.state === 'Written') {
          expect(entry.headerCrc.ok, `hdr crc failed for key=${entry.key}`).toBe(true);
        }
      }
    }

    // Locate a couple of known values.
    const allWritten = dump.pages.flatMap((p) => p.entries).filter((e) => e.state === 'Written');
    const greeting = allWritten.find((e) => e.key === 'greeting');
    expect(greeting?.type).toBe('string');

    const u64 = allWritten.find((e) => e.key === 'u64_val');
    expect(u64?.type).toBe('u64');
    if (u64?.data?.kind === 'int') {
      expect(u64.data.value).toBe(18446744073709551615n);
    }

    const i32 = allWritten.find((e) => e.key === 'i32_val');
    if (i32?.data?.kind === 'int') {
      expect(i32.data.value).toBe(-2147483648n);
    }
  });

  it('parses the golden binary and verifies all CRCs', () => {
    const golden = new Uint8Array(readFileSync(join(fixtures, 'nvs_basic.bin')));
    const dump = parse(golden);
    for (const page of dump.pages) {
      if (page.header.status === 'Empty') continue;
      expect(page.header.crc.ok).toBe(true);
      for (const entry of page.entries) {
        if (entry.state === 'Written') expect(entry.headerCrc.ok).toBe(true);
      }
    }
  });

  it('reconstructs multipage blob payloads across pages', () => {
    const payload = new Uint8Array(5000);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    const produced = new NvsBuilder().namespace('storage').binary('big_blob', payload).build();
    const dump = parse(generate(produced, { size: 0x5000, version: 2 }));

    const written = dump.pages
      .flatMap((page) => page.entries)
      .filter((entry) => entry.state === 'Written');
    const index = written.find((entry) => entry.key === 'big_blob' && entry.type === 'blob_index');
    expect(index?.blobChunks.length).toBeGreaterThan(1);
    expect(index?.valueBytes).toEqual(payload);
  });

  it('logs a warning when an NVS page header CRC is corrupted', () => {
    const csv = readFileSync(join(fixtures, 'nvs_basic.csv'), 'utf8');
    const entries = parseCSV(csv);
    const produced = generate(entries, { size: 0x4000, version: 2 });
    produced[28] = 0x00;

    const warnings: ParseWarning[] = [];
    const dump = parse(produced, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(dump.pages[0]!.header.crc.ok).toBe(false);
    expect(dump.warnings.some((warning) => /bad header CRC/i.test(warning.reason))).toBe(true);
    expect(warnings).toEqual(dump.warnings);
  });

  it('treats uninitialized pages with residual data as corrupted instead of empty', () => {
    const image = new Uint8Array(0x3000).fill(0xff);
    image[0x1000 + 64] = 0x00;

    const dump = parse(image);
    const page = dump.pages[1]!;

    expect(page.isEmpty).toBe(false);
    expect(page.header.status).toBe('Corrupted');
  });

  it('decodes keys with non-printable bytes and emits a warning', () => {
    const csv = readFileSync(join(fixtures, 'nvs_basic.csv'), 'utf8');
    const entries = parseCSV(csv);
    const image = generate(entries, { size: 0x4000, version: 2 });
    const dumpBefore = parse(image);
    const target = dumpBefore.pages
      .flatMap((page) => page.entries.map((entry) => ({ page, entry })))
      .find(({ entry }) => entry.key === 'u8_val' && entry.state === 'Written');
    expect(target).toBeDefined();

    const entryOffset = target!.page.startAddress + 64 + target!.entry.index * 32;
    image[entryOffset + 8] = 0x01;
    rewriteEntryCrc(image.subarray(entryOffset, entryOffset + 32));

    const warnings: ParseWarning[] = [];
    const dump = parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    const entry = dump.pages
      .flatMap((page) => page.entries)
      .find((e) => e.index === target!.entry.index && e.state === 'Written');

    expect(entry?.key.length).toBeGreaterThan(0);
    expect(
      warnings.some((warning) => /non-printable characters in key/i.test(warning.reason)),
    ).toBe(true);
  });

  it('prefers the newest blob_index when duplicate indices exist', () => {
    const payload = new Uint8Array(5000).fill(0x5a);
    const image = generate(
      new NvsBuilder().namespace('storage').binary('big_blob', payload).build(),
      { size: 0x5000, version: 2 },
    );
    const initial = parse(image);
    const indices = initial.pages.flatMap((page) =>
      page.entries
        .filter((entry) => entry.key === 'big_blob' && entry.type === 'blob_index')
        .map((entry) => ({ page, entry })),
    );
    expect(indices).toHaveLength(1);

    const winner = indices[0]!;
    const loserPage = [...initial.pages]
      .filter((page) => !page.isEmpty && page.header.pageIndex < winner.page.header.pageIndex)
      .sort((a, b) => b.header.pageIndex - a.header.pageIndex)[0];
    expect(loserPage).toBeDefined();

    const hostEntry = loserPage!.entries.find(
      (entry) => entry.state === 'Written' && entry.type !== 'blob_data',
    );
    expect(hostEntry).toBeDefined();

    const hostOffset = loserPage!.startAddress + 64 + hostEntry!.index * 32;
    image.set(winner.entry.raw, hostOffset);
    rewriteEntryCrc(image.subarray(hostOffset, hostOffset + 32));

    const warnings: ParseWarning[] = [];
    const dump = parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(warnings.some((warning) => /stale blob_index superseded/i.test(warning.reason))).toBe(
      true,
    );

    const active = dump.pages
      .flatMap((page) => page.entries)
      .find((entry) => entry.key === 'big_blob' && entry.type === 'blob_index' && entry.valueBytes);
    expect(active?.valueBytes).toEqual(payload);
  });

  it('logs a warning when a blob_index exceeds the theoretical maximum size', () => {
    const payload = new Uint8Array(5000).fill(0x5a);
    const image = generate(
      new NvsBuilder().namespace('storage').binary('big_blob', payload).build(),
      { size: 0x5000, version: 2 },
    );
    const dump = parse(image);
    const blobIndex = dump.pages
      .flatMap((page) => page.entries.map((entry) => ({ page, entry })))
      .find(({ entry }) => entry.key === 'big_blob' && entry.type === 'blob_index');

    expect(blobIndex).toBeDefined();
    const entryOffset = blobIndex!.page.startAddress + 64 + blobIndex!.entry.index * 32;
    new DataView(image.buffer, image.byteOffset + entryOffset, 32).setUint32(24, 0x3fffff, true);
    rewriteEntryCrc(image.subarray(entryOffset, entryOffset + 32));

    const warnings: ParseWarning[] = [];
    parse(image, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(
      warnings.some((warning) =>
        /blob_index data length .* exceeds max theoretical size/i.test(warning.reason),
      ),
    ).toBe(true);
  });
});

describe('NVS - builder & object API', () => {
  it('builder produces the same binary as an equivalent CSV', () => {
    const csvEntries = parseCSV(
      'key,type,encoding,value\n' +
        'storage,namespace,,\n' +
        'greeting,data,string,hello\n' +
        'flag,data,u8,1\n' +
        'ratio,data,float,1.5\n' +
        'precise,data,double,3.141592653589793\n' +
        'blob,data,hex2bin,deadbeef\n',
    );
    const builderEntries = new NvsBuilder()
      .namespace('storage')
      .string('greeting', 'hello')
      .u8('flag', 1)
      .float('ratio', 1.5)
      .double('precise', Math.PI)
      .binary('blob', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
      .build();
    const a = generate(csvEntries, { size: 0x3000, version: 2 });
    const b = generate(builderEntries, { size: 0x3000, version: 2 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('fromObject accepts plain objects and maps with inferred widths', () => {
    const entries = fromObject({
      storage: {
        greeting: 'hi',
        count: 10, // inferred u32
        negative: -1, // inferred i32
        big: 1n << 40n, // inferred u64
        negBig: -(1n << 40n), // inferred i64
        blob: new Uint8Array([1, 2, 3]),
        flag: { type: 'u8', value: 1 },
        ratio: { type: 'float', value: 1.25 },
        precise: { type: 'double', value: -Math.PI },
        hex: { type: 'binary', value: 'deadbeef', encoding: 'hex2bin' },
      },
    });
    const bin = generate(entries, { size: 0x3000, version: 2 });
    const dump = parse(bin);
    const written = dump.pages.flatMap((p) => p.entries).filter((e) => e.state === 'Written');
    const byKey = new Map(written.map((e) => [e.key, e]));
    expect(byKey.get('count')?.type).toBe('u32');
    expect(byKey.get('negative')?.type).toBe('i32');
    expect(byKey.get('big')?.type).toBe('u64');
    expect(byKey.get('negBig')?.type).toBe('i64');
    expect(byKey.get('flag')?.type).toBe('u8');
    expect(byKey.get('greeting')?.type).toBe('string');
    expect(byKey.get('ratio')?.type).toBe('float');
    expect(byKey.get('precise')?.type).toBe('double');
    // In V2 binary blobs are stored as blob_index + one or more blob_data entries.
    expect(byKey.get('blob')?.type).toBe('blob_index');
    expect(byKey.get('hex')?.type).toBe('blob_index');
  });

  it('builder supports explicit float and double values', () => {
    const dump = parse(
      generate(
        new NvsBuilder()
          .namespace('storage')
          .float('ratio', 1.5)
          .double('precise', Math.PI)
          .build(),
        { size: 0x3000, version: 2 },
      ),
    );
    const written = dump.pages
      .flatMap((page) => page.entries)
      .filter((entry) => entry.state === 'Written');
    const ratio = written.find((entry) => entry.key === 'ratio');
    const precise = written.find((entry) => entry.key === 'precise');

    expect(ratio?.data).toMatchObject({ kind: 'float' });
    if (!ratio?.data || ratio.data.kind !== 'float') throw new Error('ratio float entry missing');
    expect(ratio.data.value).toBeCloseTo(1.5, 6);
    expect(precise?.data).toMatchObject({ kind: 'float' });
    if (!precise?.data || precise.data.kind !== 'float') {
      throw new Error('precise double entry missing');
    }
    expect(precise.data.value).toBeCloseTo(Math.PI, 12);
  });

  it('fromObject preserves namespace insertion order (Map path)', () => {
    const input = new Map<string, Record<string, unknown>>([
      ['b_ns', { v: 1 }],
      ['a_ns', { v: 2 }],
    ]);
    const entries = fromObject(input as Parameters<typeof fromObject>[0]);
    const nsSequence = entries.filter((e) => e.type === 'namespace').map((e) => e.key);
    expect(nsSequence).toEqual(['b_ns', 'a_ns']);
  });
});

describe('NVS - error handling', () => {
  it('rejects sizes below 3 pages', () => {
    expect(() => generate([{ type: 'namespace', key: 'x' }], { size: 0x1000 })).toThrow(/0x3000/);
  });
  it('rejects non-aligned sizes', () => {
    expect(() => generate([{ type: 'namespace', key: 'x' }], { size: 0x3001 })).toThrow(/multiple/);
  });
  it('rejects oversized keys', () => {
    expect(() =>
      generate(
        [
          { type: 'namespace', key: 'ns' },
          { type: 'u8', key: 'this_key_is_too_long', value: 1 },
        ],
        { size: 0x3000 },
      ),
    ).toThrow(/too long/);
  });
  it('rejects integer values outside the target NVS type range', () => {
    expect(() =>
      generate(
        [
          { type: 'namespace', key: 'ns' },
          { type: 'u8', key: 'x', value: -1 },
        ],
        { size: 0x3000 },
      ),
    ).toThrow(/out of range.*u8/i);

    expect(() =>
      generate(
        [
          { type: 'namespace', key: 'ns' },
          { type: 'i8', key: 'x', value: 128 },
        ],
        { size: 0x3000 },
      ),
    ).toThrow(/out of range.*i8/i);

    expect(() =>
      generate(
        [
          { type: 'namespace', key: 'ns' },
          { type: 'u64', key: 'x', value: '18446744073709551616' },
        ],
        { size: 0x3000 },
      ),
    ).toThrow(/out of range.*u64/i);
  });

  it('rejects unsafe JavaScript numbers for integer encodings', () => {
    expect(() =>
      generate(
        [
          { type: 'namespace', key: 'ns' },
          { type: 'u64', key: 'x', value: Number.MAX_SAFE_INTEGER + 1 },
        ],
        { size: 0x3000 },
      ),
    ).toThrow(/safe integer range/i);
  });
});

describe('NVS - parseCSV robustness', () => {
  it('parses quoted CSV fields with escaped quotes', () => {
    const csv =
      'key,type,encoding,value\nstorage,namespace,,\ngreet,data,string,"hello ""world"""\n';
    const entries = parseCSV(csv);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ type: 'string', key: 'greet', value: 'hello "world"' });
  });

  it('skips comment lines starting with #', () => {
    const csv = 'key,type,encoding,value\n# this is a comment\nstorage,namespace,,\n';
    const entries = parseCSV(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'namespace', key: 'storage' });
  });

  it('throws on invalid header columns', () => {
    const csv = 'name,type,encoding,value\nstorage,namespace,,\n';
    expect(() => parseCSV(csv)).toThrow(/header/);
  });

  it('throws on row with fewer than 4 columns', () => {
    const csv = 'key,type,encoding,value\nstorage,namespace\n';
    expect(() => parseCSV(csv)).toThrow(/4 columns/);
  });

  it('throws on unsupported encoding', () => {
    const csv = 'key,type,encoding,value\nstorage,namespace,,\nfoo,data,unknown_enc,123\n';
    expect(() => parseCSV(csv)).toThrow(/unsupported encoding/);
  });

  it('rejects invalid hex2bin characters during generation', () => {
    expect(() =>
      generate(
        [
          { type: 'namespace', key: 'storage' },
          { type: 'binary', key: 'blob', value: '0g', encoding: 'hex2bin' },
        ],
        { size: 0x3000 },
      ),
    ).toThrow(/invalid hex character/i);
  });

  it('throws when the first data row is not a namespace entry', () => {
    const csv = 'key,type,encoding,value\nfoo,data,u8,1\n';
    expect(() => parseCSV(csv)).toThrow(/first data row must be a namespace/);
  });

  it('handles file datatype with fileLoader', () => {
    const content = new Uint8Array([0xaa, 0xbb]);
    const csv = 'key,type,encoding,value\nstorage,namespace,,\nblob,file,binary,/path/to/file\n';
    const entries = parseCSV(csv, { fileLoader: () => content });
    expect(entries[1]).toMatchObject({ type: 'binary', key: 'blob' });
    expect((entries[1] as { value: Uint8Array }).value).toEqual(content);
  });

  it('throws on file datatype without fileLoader', () => {
    const csv = 'key,type,encoding,value\nstorage,namespace,,\nblob,file,binary,/path/to/file\n';
    expect(() => parseCSV(csv)).toThrow(/fileLoader/);
  });

  it('handles base64 encoding', () => {
    const csv = 'key,type,encoding,value\nstorage,namespace,,\nblob,data,base64,AAEC\n';
    const entries = parseCSV(csv);
    expect(entries[1]).toMatchObject({ type: 'binary', key: 'blob', encoding: 'base64' });
  });

  it('parses float and double encodings from CSV', () => {
    const csv =
      'key,type,encoding,value\nstorage,namespace,,\nratio,data,float,1.5\nprecise,data,double,-3.141592653589793\n';
    const entries = parseCSV(csv);
    expect(entries[1]).toMatchObject({ type: 'float', key: 'ratio', value: '1.5' });
    expect(entries[2]).toMatchObject({
      type: 'double',
      key: 'precise',
      value: '-3.141592653589793',
    });
  });

  it('handles file datatype with string/base64/hex2bin encodings', () => {
    const files = new Map<string, Uint8Array>([
      ['/str.txt', new TextEncoder().encode('hello from file')],
      ['/b64.txt', new TextEncoder().encode('AAEC')],
      ['/hex.txt', new TextEncoder().encode('deadbeef')],
    ]);
    const csv =
      'key,type,encoding,value\n' +
      'storage,namespace,,\n' +
      'greeting,file,string,/str.txt\n' +
      'blob64,file,base64,/b64.txt\n' +
      'blobhex,file,hex2bin,/hex.txt\n';
    const entries = parseCSV(csv, {
      fileLoader(path) {
        return files.get(path)!;
      },
    });
    expect(entries[1]).toMatchObject({ type: 'string', key: 'greeting', value: 'hello from file' });
    expect(entries[2]).toMatchObject({
      type: 'binary',
      key: 'blob64',
      encoding: 'base64',
      value: 'AAEC',
    });
    expect(entries[3]).toMatchObject({
      type: 'binary',
      key: 'blobhex',
      encoding: 'hex2bin',
      value: 'deadbeef',
    });
  });
});

describe('NVS - NvsBuilder input validation', () => {
  it('throws when adding key without namespace', () => {
    const builder = new NvsBuilder();
    expect(() => builder.string('key', 'val')).toThrow(/namespace/);
  });

  it('throws on empty namespace name', () => {
    const builder = new NvsBuilder();
    expect(() => builder.namespace('')).toThrow(/empty/);
  });
});

describe('NVS - fromObject error paths', () => {
  it('rejects non-integer number values', () => {
    expect(() => fromObject({ ns: { key: 1.5 } })).toThrow(/non-integer/);
  });

  it('rejects NaN values', () => {
    expect(() => fromObject({ ns: { key: NaN } })).toThrow(/non-integer/);
  });

  it('rejects Infinity values', () => {
    expect(() => fromObject({ ns: { key: Infinity } })).toThrow(/non-integer/);
  });

  it('rejects unknown explicit type', () => {
    expect(() => fromObject({ ns: { key: { type: 'unknown' as 'u8', value: 1 } } })).toThrow(
      /unknown NVS value type/,
    );
  });

  it('rejects completely unsupported value types', () => {
    expect(() => fromObject({ ns: { key: true as unknown as string } })).toThrow(
      /unsupported NVS value/,
    );
  });

  it('rejects empty namespace name', () => {
    expect(() => fromObject({ '': { key: 1 } })).toThrow(/invalid NVS namespace/);
  });
});

function rewriteEntryCrc(entry: Uint8Array): void {
  const crcBuf = new Uint8Array(28);
  crcBuf.set(entry.subarray(0, 4), 0);
  crcBuf.set(entry.subarray(8, 32), 4);
  new DataView(entry.buffer, entry.byteOffset, entry.byteLength).setUint32(
    4,
    crc32Nvs(crcBuf) >>> 0,
    true,
  );
}
