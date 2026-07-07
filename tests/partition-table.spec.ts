import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PartitionTable } from '../src/partition-table/index.js';
import { parseEntry, encodeEntry, verifyEntry, parseCsvRow } from '../src/partition-table/entry.js';
import type { ParseWarning } from '../src/common/diagnostics.js';
import { InputError, ValidationError } from '../src/common/errors.js';
import {
  APP_TYPE,
  DATA_TYPE,
  DEFAULT_OFFSET_PART_TABLE,
  parseInteger,
  SUBTYPES,
} from '../src/partition-table/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

function loadFixture(name: string): { csv: string; bin: Uint8Array } {
  const csv = readFileSync(join(fixtures, `${name}.csv`), 'utf8');
  const bin = new Uint8Array(readFileSync(join(fixtures, `${name}.bin`)));
  return { csv, bin };
}

describe('PartitionTable - golden fixtures', () => {
  it('matches gen_esp32part.py output for partitions_singleapp.csv byte-for-byte', () => {
    const { csv, bin } = loadFixture('partitions_singleapp');
    const table = PartitionTable.fromCSV(csv);
    const produced = table.toBinary();
    expect(produced.byteLength).toBe(bin.byteLength);
    expect(Array.from(produced)).toEqual(Array.from(bin));
  });

  it('matches gen_esp32part.py output for partitions_two_ota.csv byte-for-byte', () => {
    const { csv, bin } = loadFixture('partitions_two_ota');
    const table = PartitionTable.fromCSV(csv);
    const produced = table.toBinary();
    expect(Array.from(produced)).toEqual(Array.from(bin));
  });

  it('parses a binary partition table back to matching entries', () => {
    const { csv, bin } = loadFixture('partitions_singleapp');
    const fromBin = PartitionTable.fromBinary(bin);
    const fromCsv = PartitionTable.fromCSV(csv);
    // Round-trip through toBinary to compare canonical shape.
    expect(Array.from(fromBin.toBinary())).toEqual(Array.from(fromCsv.toBinary()));
    // And verify find() works.
    const factory = fromBin.find({ name: 'factory' });
    expect(factory).toBeDefined();
    expect(factory?.size).toBe(0x100000);
  });
});

describe('PartitionTable - CSV round-trip', () => {
  it('re-emits sensible CSV rows', () => {
    const { csv } = loadFixture('partitions_singleapp');
    const table = PartitionTable.fromCSV(csv);
    const outCsv = table.toCSV();
    // Re-parsing our own output should produce the same binary image.
    const roundTrip = PartitionTable.fromCSV(outCsv);
    expect(Array.from(roundTrip.toBinary())).toEqual(Array.from(table.toBinary()));
  });
});

describe('PartitionTable - validation', () => {
  it('rejects primary bootloader offsets at or above the partition table offset during CSV parsing', () => {
    const csv = 'bootloader, bootloader, primary, N/A, N/A';
    expect(() =>
      PartitionTable.fromCSV(csv, {
        offsetPartTable: 0x8000,
        primaryBootloaderOffset: 0x8000,
      }),
    ).toThrow(/primary bootloader offset/i);
  });

  it('detects overlaps', () => {
    const csv = `
# name, type, subtype, offset, size
nvs, data, nvs, 0x9000, 0x6000
app, app, factory, 0xB000, 0x100000
`;
    expect(() => PartitionTable.fromCSV(csv)).toThrow(/overlaps/);
  });

  it('detects missing size', () => {
    const csv = 'nvs, data, nvs, 0x9000,';
    expect(() => PartitionTable.fromCSV(csv)).toThrow(/size field/);
  });

  it('verify() rejects duplicate names', () => {
    const csv = `
nvs, data, nvs, , 0x6000
nvs, data, nvs, , 0x6000
`;
    const table = PartitionTable.fromCSV(csv);
    expect(() => table.verify()).toThrow(/duplicate/);
  });

  it('fromBinary detects MD5 mismatches', () => {
    const { bin } = loadFixture('partitions_singleapp');
    const tampered = new Uint8Array(bin);
    // Flip a byte inside the first entry's size field.
    tampered[8 + 6]! ^= 0x01;
    expect(() => PartitionTable.fromBinary(tampered)).toThrow(/MD5/);
  });

  it('fromBinary warns on multiple MD5 checksum rows but still parses best-effort', () => {
    const { bin } = loadFixture('partitions_singleapp');
    const dup = new Uint8Array(bin.length + 32);
    dup.set(bin.subarray(0, 0x80), 0);
    dup.set(bin.subarray(0x60, 0x80), 0x80);
    dup.set(bin.subarray(0x80), 0xa0);
    const warnings: ParseWarning[] = [];
    const parsed = PartitionTable.fromBinary(dup, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(parsed.entries).toHaveLength(3);
    expect(
      parsed.warnings.some((warning) => /multiple MD5 checksum rows/i.test(warning.reason)),
    ).toBe(true);
    expect(warnings).toEqual(parsed.warnings);
  });

  it('fromBinary warns on an empty all-0xFF table and returns an empty result', () => {
    const empty = new Uint8Array(0xc00);
    empty.fill(0xff);
    const warnings: ParseWarning[] = [];
    const parsed = PartitionTable.fromBinary(empty, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(parsed.entries).toHaveLength(0);
    expect(
      parsed.warnings.some((warning) =>
        /empty table|first row is the all-0xFF end marker/i.test(warning.reason),
      ),
    ).toBe(true);
    expect(warnings).toEqual(parsed.warnings);
  });

  it('fromBinary warns when a partition exceeds the configured flash size', () => {
    const row = encodeEntry({
      name: 'factory',
      type: APP_TYPE,
      subtype: 0,
      offset: 0x10000,
      size: 0x200000,
      encrypted: false,
      readonly: false,
    });
    const bin = new Uint8Array(64);
    bin.fill(0xff);
    bin.set(row, 0);
    const warnings: ParseWarning[] = [];
    const parsed = PartitionTable.fromBinary(bin, {
      flashSize: 0x180000,
      md5Sum: false,
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(parsed.entries).toHaveLength(1);
    expect(
      parsed.warnings.some((warning) =>
        /exceeds configured flash size|rejected by esp_partition_table_verify/i.test(
          warning.reason,
        ),
      ),
    ).toBe(true);
    expect(warnings).toEqual(parsed.warnings);
  });

  it('fromBinary decodes invalid UTF-8 names best-effort and warns', () => {
    const bad = new Uint8Array(64);
    bad.fill(0xff);
    bad[0] = 0xaa;
    bad[1] = 0x50;
    bad[2] = DATA_TYPE;
    bad[3] = SUBTYPES[DATA_TYPE]!.nvs!;
    const view = new DataView(bad.buffer);
    view.setUint32(4, 0x9000, true);
    view.setUint32(8, 0x3000, true);
    bad[12] = 0x62;
    bad[13] = 0x61;
    bad[14] = 0x64;
    bad[15] = 0xff;
    const warnings: ParseWarning[] = [];
    const parsed = PartitionTable.fromBinary(bad, {
      md5Sum: false,
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.name).toContain('\uFFFD');
    expect(parsed.warnings.some((warning) => /invalid UTF-8/i.test(warning.reason))).toBe(true);
    expect(warnings).toEqual(parsed.warnings);
  });

  it('fromBinary warns on unknown flag bits but keeps parsing', () => {
    const row = encodeEntry({
      name: 'nvs',
      type: DATA_TYPE,
      subtype: SUBTYPES[DATA_TYPE]!.nvs!,
      offset: 0x9000,
      size: 0x3000,
      encrypted: false,
      readonly: false,
    });
    new DataView(row.buffer, row.byteOffset, row.byteLength).setUint32(28, 1 << 5, true);
    const bin = new Uint8Array(64);
    bin.fill(0xff);
    bin.set(row, 0);
    const warnings: ParseWarning[] = [];
    const parsed = PartitionTable.fromBinary(bin, {
      md5Sum: false,
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.warnings.some((warning) => /unknown flag bits/i.test(warning.reason))).toBe(true);
    expect(warnings).toEqual(parsed.warnings);
  });
});

describe('parseEntry / encodeEntry', () => {
  it('throws on data that is not 32 bytes', () => {
    expect(() => parseEntry(new Uint8Array(16))).toThrow(InputError);
    expect(() => parseEntry(new Uint8Array(64))).toThrow(InputError);
  });

  it('throws on invalid magic bytes', () => {
    const bad = new Uint8Array(32);
    bad[0] = 0x00;
    bad[1] = 0x00;
    expect(() => parseEntry(bad)).toThrow(/magic/i);
  });

  it('throws on invalid UTF-8 partition names', () => {
    const bad = new Uint8Array(32);
    bad[0] = 0xaa;
    bad[1] = 0x50;
    bad[2] = DATA_TYPE;
    bad[3] = SUBTYPES[DATA_TYPE]!.nvs!;
    const view = new DataView(bad.buffer);
    view.setUint32(4, 0x9000, true);
    view.setUint32(8, 0x3000, true);
    bad[12] = 0x62;
    bad[13] = 0x61;
    bad[14] = 0x64;
    bad[15] = 0xff;
    expect(() => parseEntry(bad)).toThrow(/UTF-8/);
  });

  it('can decode invalid UTF-8 partition names in best-effort mode', () => {
    const bad = new Uint8Array(32);
    bad[0] = 0xaa;
    bad[1] = 0x50;
    bad[2] = DATA_TYPE;
    bad[3] = SUBTYPES[DATA_TYPE]!.nvs!;
    const view = new DataView(bad.buffer);
    view.setUint32(4, 0x9000, true);
    view.setUint32(8, 0x3000, true);
    bad[12] = 0x62;
    bad[13] = 0x61;
    bad[14] = 0x64;
    bad[15] = 0xff;
    const warnings: ParseWarning[] = [];
    const parsed = parseEntry(bad, {
      bestEffort: true,
      subject: 'row 0',
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(parsed.name).toContain('\uFFFD');
    expect(warnings.some((warning) => /invalid UTF-8/i.test(warning.reason))).toBe(true);
  });

  it('encodeEntry throws on names longer than 16 UTF-8 bytes', () => {
    expect(() =>
      encodeEntry({
        name: 'this_name_is_way_too_long',
        type: DATA_TYPE,
        subtype: 0,
        offset: 0x9000,
        size: 0x6000,
        encrypted: false,
        readonly: false,
      }),
    ).toThrow(/longer than 16/);
    expect(() =>
      encodeEntry({
        name: 'phy_инит__123',
        type: DATA_TYPE,
        subtype: 0,
        offset: 0x9000,
        size: 0x6000,
        encrypted: false,
        readonly: false,
      }),
    ).toThrow(/UTF-8/);
  });

  it('round-trips encrypted and readonly flags', () => {
    const entry = {
      name: 'test',
      type: DATA_TYPE,
      subtype: 0x02,
      offset: 0x9000,
      size: 0x6000,
      encrypted: true,
      readonly: true,
    };
    const bin = encodeEntry(entry);
    const parsed = parseEntry(bin);
    expect(parsed.encrypted).toBe(true);
    expect(parsed.readonly).toBe(true);
  });

  it('round-trips UTF-8 partition names like ESP-IDF', () => {
    const entry = {
      name: 'phy_инит_',
      type: DATA_TYPE,
      subtype: SUBTYPES[DATA_TYPE]!.phy!,
      offset: 0xf000,
      size: 0x1000,
      encrypted: false,
      readonly: false,
    };
    const bin = encodeEntry(entry);
    const parsed = parseEntry(bin);
    expect(parsed.name).toBe(entry.name);
  });

  it('rejects out-of-range numeric fields instead of truncating them', () => {
    expect(() =>
      encodeEntry({
        name: 'test',
        type: 0x100,
        subtype: 0,
        offset: 0x9000,
        size: 0x6000,
        encrypted: false,
        readonly: false,
      }),
    ).toThrow(/type/);
    expect(() =>
      encodeEntry({
        name: 'test',
        type: DATA_TYPE,
        subtype: -1,
        offset: 0x9000,
        size: 0x6000,
        encrypted: false,
        readonly: false,
      }),
    ).toThrow(/subtype/);
    expect(() =>
      encodeEntry({
        name: 'test',
        type: DATA_TYPE,
        subtype: 0,
        offset: -1,
        size: 0x6000,
        encrypted: false,
        readonly: false,
      }),
    ).toThrow(/offset/);
  });
});

describe('verifyEntry', () => {
  const ctx = {
    offsetPartTable: DEFAULT_OFFSET_PART_TABLE,
    primaryBootloaderOffset: null,
    secure: 'none' as const,
  };

  it('throws on unaligned app offset', () => {
    expect(() =>
      verifyEntry(
        {
          name: 'app',
          type: APP_TYPE,
          subtype: 0,
          offset: 0x1234,
          size: 0x1000,
          encrypted: false,
          readonly: false,
        },
        ctx,
      ),
    ).toThrow(ValidationError);
  });

  it('throws on app size not aligned to 4K', () => {
    expect(() =>
      verifyEntry(
        {
          name: 'app',
          type: APP_TYPE,
          subtype: 0,
          offset: 0x10000,
          size: 0x1234,
          encrypted: false,
          readonly: false,
        },
        ctx,
      ),
    ).toThrow(ValidationError);
  });

  it('throws on NVS r/w partition below minimum size', () => {
    expect(() =>
      verifyEntry(
        {
          name: 'nvs',
          type: DATA_TYPE,
          subtype: SUBTYPES[DATA_TYPE]!.nvs!,
          offset: 0x9000,
          size: 0x2000,
          encrypted: false,
          readonly: false,
        },
        ctx,
      ),
    ).toThrow(ValidationError);
  });

  it('allows readonly NVS partition below minimum size', () => {
    expect(() =>
      verifyEntry(
        {
          name: 'nvs',
          type: DATA_TYPE,
          subtype: SUBTYPES[DATA_TYPE]!.nvs!,
          offset: 0x9000,
          size: 0x2000,
          encrypted: false,
          readonly: true,
        },
        ctx,
      ),
    ).not.toThrow();
  });

  it('rejects readonly otadata partitions', () => {
    expect(() =>
      verifyEntry(
        {
          name: 'otadata',
          type: DATA_TYPE,
          subtype: SUBTYPES[DATA_TYPE]!.ota!,
          offset: 0x9000,
          size: 0x2000,
          encrypted: false,
          readonly: true,
        },
        ctx,
      ),
    ).toThrow(/always read-write|readonly/);
  });

  it('requires 64K app size alignment for secure boot v1', () => {
    expect(() =>
      verifyEntry(
        {
          name: 'factory',
          type: APP_TYPE,
          subtype: 0,
          offset: 0x10000,
          size: 0x11000,
          encrypted: false,
          readonly: false,
        },
        { ...ctx, secure: 'v1' },
      ),
    ).toThrow(/0x10000/);
  });
});

describe('parseCsvRow', () => {
  const ctx = {
    offsetPartTable: DEFAULT_OFFSET_PART_TABLE,
    primaryBootloaderOffset: null,
    recoveryBootloaderOffset: null,
  };

  it('throws on empty name', () => {
    expect(() => parseCsvRow(', data, nvs, 0x9000, 0x6000', 1, ctx)).toThrow(/empty name/);
  });

  it('throws on empty type', () => {
    expect(() => parseCsvRow('nvs, , nvs, 0x9000, 0x6000', 1, ctx)).toThrow(/empty type/);
  });

  it('parses flags: encrypted and readonly', () => {
    const result = parseCsvRow('nvs, data, nvs, 0x9000, 0x6000, encrypted:readonly', 1, ctx);
    expect(result.encrypted).toBe(true);
    expect(result.readonly).toBe(true);
  });

  it('throws on unknown flag', () => {
    expect(() => parseCsvRow('nvs, data, nvs, 0x9000, 0x6000, badFlag', 1, ctx)).toThrow(
      /unknown flag/,
    );
  });

  it('throws on app partition with empty subtype', () => {
    expect(() => parseCsvRow('myapp, app, , 0x10000, 0x100000', 1, ctx)).toThrow(/empty subtype/);
  });

  it('resolves recovery bootloader offset from options', () => {
    const result = parseCsvRow('RecoveryBTLDR, bootloader, recovery, N/A, N/A', 1, {
      offsetPartTable: 0x9000,
      primaryBootloaderOffset: 0x1000,
      recoveryBootloaderOffset: 0x200000,
    });
    expect(result.offset).toBe(0x200000);
    expect(result.size).toBe(0x8000);
  });

  it('parses custom subtype names from extraSubtypes', () => {
    const result = parseCsvRow('calib, data, calib, 0x9000, 0x1000', 1, {
      offsetPartTable: DEFAULT_OFFSET_PART_TABLE,
      primaryBootloaderOffset: null,
      recoveryBootloaderOffset: null,
      extraSubtypes: {
        data: {
          calib: 0x40,
        },
      },
    });
    expect(result.subtype).toBe(0x40);
  });
});

describe('PartitionTable - IDF compatibility gaps', () => {
  it('parses recovery bootloader rows like gen_esp32part.py', () => {
    const csv = `
bootloader,       bootloader,       primary, N/A, N/A
partition_table,  partition_table,  primary, N/A, N/A
FactoryApp,       app,              factory, ,    1M
OtaBTLDR,         bootloader,       ota,     ,    N/A
OtaPrtTable,      partition_table,  ota,     ,    N/A
RecoveryBTLDR,    bootloader,       recovery, N/A, N/A
`;
    const table = PartitionTable.fromCSV(csv, {
      offsetPartTable: 0x9000,
      primaryBootloaderOffset: 0x1000,
      recoveryBootloaderOffset: 0x200000,
    });
    expect(table.find({ name: 'RecoveryBTLDR' })?.offset).toBe(0x200000);
    expect(table.find({ name: 'RecoveryBTLDR' })?.size).toBe(0x8000);
  });

  it('verify rejects secure v1 app sizes that are not 64K aligned', () => {
    const table = new PartitionTable(
      [{ name: 'factory', type: 'app', subtype: 'factory', offset: 0x10000, size: 0x11000 }],
      { secure: 'v1' },
    );
    expect(() => table.verify()).toThrow(/0x10000/);
  });

  it('verify rejects primary bootloader offsets at or above the partition table offset', () => {
    const table = new PartitionTable(
      [
        {
          name: 'bootloader',
          type: 'bootloader',
          subtype: 'primary',
          offset: 0x9000,
          size: 0x1000,
        },
      ],
      { offsetPartTable: 0x9000, primaryBootloaderOffset: 0x9000 },
    );
    expect(() => table.verify()).toThrow(/primary bootloader offset/i);
  });

  it('fromCSV also rejects primary bootloader offsets at or above the default partition table offset', () => {
    const csv = 'bootloader, bootloader, primary, N/A, N/A';
    expect(() =>
      PartitionTable.fromCSV(csv, {
        primaryBootloaderOffset: DEFAULT_OFFSET_PART_TABLE,
      }),
    ).toThrow(/primary bootloader offset/i);
  });

  it('toBinary rejects invalid tables instead of silently encoding them', () => {
    const table = new PartitionTable([
      { name: 'nvs', type: 'data', subtype: 'nvs', offset: 0x9000, size: 0x8000 },
      { name: 'factory', type: 'app', subtype: 'factory', offset: 0x10000, size: 0x100000 },
    ]);
    expect(() => table.toBinary()).toThrow(/overlap/i);
  });

  it('does not enforce a 4 MiB flash limit unless flashSize is explicitly set', () => {
    const entries = [
      { name: 'factory', type: 'app', subtype: 'factory', offset: 0x10000, size: 0x790000 },
    ];
    const table = new PartitionTable(entries);
    expect(() => table.verify()).not.toThrow();
    expect(() => table.toBinary()).not.toThrow();
    expect(() => new PartitionTable(entries, { flashSize: 4 * 1024 * 1024 }).verify()).toThrow(
      /flash size/,
    );
  });

  it('supports custom subtype names across CSV, binary, find, and CSV export', () => {
    const csv = 'calib, data, calib, 0x9000, 0x1000';
    const extraSubtypes = {
      data: {
        calib: 0x40,
      },
    };
    const table = PartitionTable.fromCSV(csv, { extraSubtypes });
    expect(table.entries[0]?.subtype).toBe('calib');
    expect(table.find({ type: 'data', subtype: 'calib' })?.name).toBe('calib');

    const reparsed = PartitionTable.fromBinary(table.toBinary(), { extraSubtypes });
    expect(reparsed.entries[0]?.subtype).toBe('calib');
    expect(reparsed.toCSV()).toContain('calib,');
  });
});

describe('parseInteger', () => {
  it('supports octal literals like Python int(v, 0)', () => {
    expect(parseInteger('0o110000')).toBe(0x9000);
    expect(parseInteger('-0o10')).toBe(-8);
  });
});
