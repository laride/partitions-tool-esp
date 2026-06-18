import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
});

describe('NVS - builder & object API', () => {
  it('builder produces the same binary as an equivalent CSV', () => {
    const csvEntries = parseCSV(
      'key,type,encoding,value\n' +
        'storage,namespace,,\n' +
        'greeting,data,string,hello\n' +
        'flag,data,u8,1\n' +
        'blob,data,hex2bin,deadbeef\n',
    );
    const builderEntries = new NvsBuilder()
      .namespace('storage')
      .string('greeting', 'hello')
      .u8('flag', 1)
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
    // In V2 binary blobs are stored as blob_index + one or more blob_data entries.
    expect(byKey.get('blob')?.type).toBe('blob_index');
    expect(byKey.get('hex')?.type).toBe('blob_index');
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
