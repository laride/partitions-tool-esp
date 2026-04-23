import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PartitionTable } from '../src/partition-table/index.js';
import { parseEntry, encodeEntry, verifyEntry, parseCsvRow } from '../src/partition-table/entry.js';
import { InputError, ValidationError } from '../src/common/errors.js';
import {
  APP_TYPE,
  DATA_TYPE,
  DEFAULT_OFFSET_PART_TABLE,
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

  it('encodeEntry throws on name longer than 16 chars', () => {
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
});

describe('verifyEntry', () => {
  const ctx = { offsetPartTable: DEFAULT_OFFSET_PART_TABLE, primaryBootloaderOffset: null };

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
});

describe('parseCsvRow', () => {
  const ctx = { offsetPartTable: DEFAULT_OFFSET_PART_TABLE, primaryBootloaderOffset: null };

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
});
