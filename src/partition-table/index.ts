import { bytesEqual, concatBytes, filledBytes } from '../common/binary.js';
import { InputError, ValidationError } from '../common/errors.js';
import { md5 } from '../common/md5.js';
import {
  BOOTLOADER_TYPE,
  DATA_TYPE,
  DEFAULT_FLASH_SIZE,
  DEFAULT_OFFSET_PART_TABLE,
  getAlignmentOffsetForType,
  getPtypeName,
  getSubtypeName,
  MAX_PARTITION_LENGTH,
  MD5_PARTITION_BEGIN,
  PARTITION_ENTRY_SIZE,
  PARTITION_MAGIC,
  PARTITION_TABLE_SIZE,
  PARTITION_TABLE_TYPE,
  parseInteger,
  SUBTYPES,
  TYPES,
} from './constants.js';
import {
  encodeEntry,
  ParsedPartition,
  parseCsvRow,
  parseEntry,
  partitionToCsv,
  verifyEntry,
} from './entry.js';

export type PartitionTypeName = 'app' | 'data' | 'bootloader' | 'partition_table';

export interface PartitionEntry {
  name: string;
  /** String name (`app`, `data`, ...) or raw integer. */
  type: PartitionTypeName | number;
  /** String subtype (`factory`, `nvs`, `ota_0`, ...) or raw integer. */
  subtype: string | number;
  /** When omitted, the table resolves this automatically from alignment rules. */
  offset?: number;
  size: number;
  encrypted?: boolean;
  readonly?: boolean;
}

export interface PartitionTableOptions {
  /** Flash size in bytes. Defaults to 4 MiB. */
  flashSize?: number;
  /** Offset of the partition table in flash. Defaults to 0x8000. */
  offsetPartTable?: number;
  /** Whether to append the MD5 checksum entry. Defaults to true. */
  md5Sum?: boolean;
  /** Primary bootloader offset; required if a bootloader/primary entry is present. */
  primaryBootloaderOffset?: number;
  /** Recovery bootloader offset; required if a bootloader/recovery entry is present. */
  recoveryBootloaderOffset?: number;
  /** Secure boot version (not yet applied to alignment; reserved for future use). */
  secure?: 'none' | 'v1' | 'v2';
}

const DEFAULT_OPTS: Required<
  Pick<PartitionTableOptions, 'flashSize' | 'offsetPartTable' | 'md5Sum' | 'secure'>
> = {
  flashSize: DEFAULT_FLASH_SIZE,
  offsetPartTable: DEFAULT_OFFSET_PART_TABLE,
  md5Sum: true,
  secure: 'none',
};

function resolveTypeNumber(type: PartitionEntry['type']): number {
  if (typeof type === 'number') return type;
  if (TYPES[type] !== undefined) return TYPES[type]!;
  throw new InputError(`unknown partition type '${String(type)}'`);
}

function resolveSubtype(typeNum: number, subtype: PartitionEntry['subtype']): number {
  if (typeof subtype === 'number') return subtype;
  const map = SUBTYPES[typeNum] ?? {};
  if (map[subtype] !== undefined) return map[subtype]!;
  // Try parsing as raw integer literal.
  try {
    return parseInteger(subtype);
  } catch {
    throw new InputError(`unknown partition subtype '${subtype}' for type ${typeNum}`);
  }
}

function toParsed(p: PartitionEntry): ParsedPartition {
  const type = resolveTypeNumber(p.type);
  const subtype = resolveSubtype(type, p.subtype);
  if (p.offset === undefined) {
    throw new InputError(`entry '${p.name}' is missing an offset`);
  }
  return {
    name: p.name,
    type,
    subtype,
    offset: p.offset,
    size: p.size,
    encrypted: !!p.encrypted,
    readonly: !!p.readonly,
  };
}

function fromParsed(p: ParsedPartition): PartitionEntry {
  return {
    name: p.name,
    type: (getPtypeName(p.type) as PartitionTypeName | undefined) ?? p.type,
    subtype: getSubtypeName(p.type, p.subtype) ?? p.subtype,
    offset: p.offset,
    size: p.size,
    encrypted: p.encrypted,
    readonly: p.readonly,
  };
}

export class PartitionTable {
  readonly entries: PartitionEntry[];
  readonly options: PartitionTableOptions;

  constructor(entries: PartitionEntry[] = [], options: PartitionTableOptions = {}) {
    this.entries = entries;
    this.options = options;
  }

  /**
   * Parse a CSV definition, auto-resolving missing offsets via alignment rules.
   */
  static fromCSV(csv: string, opts: PartitionTableOptions = {}): PartitionTable {
    const { offsetPartTable } = { ...DEFAULT_OPTS, ...opts };
    const ctx = {
      offsetPartTable,
      primaryBootloaderOffset: opts.primaryBootloaderOffset ?? null,
    };

    const rows = csv.split(/\r?\n/);
    const parsed: Array<ReturnType<typeof parseCsvRow>> = [];
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i]!.trim();
      if (!line || line.startsWith('#')) continue;
      parsed.push(parseCsvRow(line, i + 1, ctx));
    }

    // Resolve missing offsets / negative sizes exactly like gen_esp32part.py does.
    let lastEnd = offsetPartTable + PARTITION_TABLE_SIZE;
    const completed: ParsedPartition[] = [];
    for (let idx = 0; idx < parsed.length; idx++) {
      const e = parsed[idx]!;
      const isPrimaryBootloader =
        e.type === BOOTLOADER_TYPE && e.subtype === SUBTYPES[BOOTLOADER_TYPE]!.primary;
      const isPrimaryPartitionTable =
        e.type === PARTITION_TABLE_TYPE && e.subtype === SUBTYPES[PARTITION_TABLE_TYPE]!.primary;
      if (isPrimaryBootloader || isPrimaryPartitionTable) {
        completed.push({
          name: e.name,
          type: e.type,
          subtype: e.subtype,
          offset: e.offset ?? 0,
          size: e.size ?? 0,
          encrypted: e.encrypted,
          readonly: e.readonly,
        });
        continue;
      }

      if (e.offset !== null && e.offset < lastEnd) {
        if (idx === 0) {
          throw new InputError(
            `CSV line ${e.lineNo}: partition '${e.name}' offset 0x${e.offset.toString(16)} overlaps partition table (ends at 0x${lastEnd.toString(16)}).`,
          );
        }
        throw new InputError(
          `CSV line ${e.lineNo}: partition '${e.name}' offset 0x${e.offset.toString(16)} overlaps previous partition ending at 0x${lastEnd.toString(16)}.`,
        );
      }

      let offset = e.offset;
      if (offset === null) {
        const padTo = getAlignmentOffsetForType(e.type);
        if (lastEnd % padTo !== 0) lastEnd += padTo - (lastEnd % padTo);
        offset = lastEnd;
      }

      if (e.size === null) {
        throw new InputError(`CSV line ${e.lineNo}: size field can't be empty`);
      }
      let size = e.size;
      if (size < 0) size = -size - offset;

      completed.push({
        name: e.name,
        type: e.type,
        subtype: e.subtype,
        offset,
        size,
        encrypted: e.encrypted,
        readonly: e.readonly,
      });
      lastEnd = offset + size;
    }

    const table = new PartitionTable(completed.map(fromParsed), opts);
    return table;
  }

  /**
   * Parse the 0xC00-byte binary partition table (or any multiple of 32 bytes).
   * The MD5 checksum row is validated if present.
   */
  static fromBinary(bin: Uint8Array, opts: PartitionTableOptions = {}): PartitionTable {
    const { md5Sum } = { ...DEFAULT_OPTS, ...opts };
    if (bin.length % PARTITION_ENTRY_SIZE !== 0) {
      throw new InputError(
        `partition table length (${bin.length}) must be a multiple of ${PARTITION_ENTRY_SIZE}`,
      );
    }
    const md5Buf: Uint8Array[] = [];
    const entries: PartitionEntry[] = [];
    const endMarker = filledBytes(PARTITION_ENTRY_SIZE, 0xff);

    for (let o = 0; o < bin.length; o += PARTITION_ENTRY_SIZE) {
      const row = bin.subarray(o, o + PARTITION_ENTRY_SIZE);
      if (bytesEqual(row, endMarker)) {
        return new PartitionTable(entries, opts);
      }
      if (md5Sum && bytesEqual(row.subarray(0, 2), MD5_PARTITION_BEGIN.subarray(0, 2))) {
        const computed = md5(concatBytes(...md5Buf));
        const stored = row.subarray(16, 32);
        if (!bytesEqual(stored, computed)) {
          throw new InputError(
            `MD5 checksum mismatch: computed ${hex(computed)}, stored ${hex(stored)}`,
          );
        }
        continue;
      }
      md5Buf.push(new Uint8Array(row));
      entries.push(fromParsed(parseEntry(row)));
    }
    throw new InputError('Partition table is missing an end-of-table marker');
  }

  toBinary(opts: PartitionTableOptions = {}): Uint8Array {
    const { md5Sum } = { ...DEFAULT_OPTS, ...this.options, ...opts };
    const parsed = this.entries.map(toParsed);
    const rows: Uint8Array[] = parsed.map(encodeEntry);
    let body = concatBytes(...rows);
    if (md5Sum) {
      const digest = md5(body);
      body = concatBytes(body, MD5_PARTITION_BEGIN, digest);
    }
    if (body.length >= MAX_PARTITION_LENGTH) {
      throw new ValidationError(
        `Binary partition table length ${body.length} exceeds max ${MAX_PARTITION_LENGTH}`,
      );
    }
    // Pad to 0xC00 with 0xFF (signing-friendly).
    const out = new Uint8Array(MAX_PARTITION_LENGTH);
    out.fill(0xff);
    out.set(body, 0);
    return out;
  }

  toCSV(simple = false): string {
    const header = ['# ESP-IDF Partition Table', '# Name, Type, SubType, Offset, Size, Flags'];
    const rows = this.entries.map((e) => partitionToCsv(toParsed(e), simple));
    return [...header, ...rows].join('\n') + '\n';
  }

  find(q: Partial<Pick<PartitionEntry, 'name' | 'type' | 'subtype'>>): PartitionEntry | undefined {
    return this.entries.find((e) => {
      if (q.name !== undefined && e.name !== q.name) return false;
      if (q.type !== undefined && resolveTypeNumber(e.type) !== resolveTypeNumber(q.type))
        return false;
      if (q.subtype !== undefined) {
        const t = resolveTypeNumber(e.type);
        if (resolveSubtype(t, e.subtype) !== resolveSubtype(t, q.subtype)) return false;
      }
      return true;
    });
  }

  /**
   * Validate offsets, overlaps, duplicate names, alignment and ESP-IDF-specific
   * constraints (NVS min size, single OTA data, etc.).
   */
  verify(): void {
    const opts = { ...DEFAULT_OPTS, ...this.options };
    const ctx = {
      offsetPartTable: opts.offsetPartTable,
      primaryBootloaderOffset: this.options.primaryBootloaderOffset ?? null,
    };

    // Per-entry validation.
    for (const e of this.entries) verifyEntry(toParsed(e), ctx);

    // Duplicate names.
    const seen = new Set<string>();
    for (const e of this.entries) {
      if (seen.has(e.name)) throw new ValidationError(`duplicate partition name '${e.name}'`);
      seen.add(e.name);
    }

    // Overlap + below-table checks.
    const sorted = [...this.entries].map(toParsed).sort((a, b) => a.offset - b.offset);
    let last: ParsedPartition | null = null;
    for (const p of sorted) {
      const isPrimaryBootloader =
        p.type === BOOTLOADER_TYPE && p.subtype === SUBTYPES[BOOTLOADER_TYPE]!.primary;
      const isPrimaryPartitionTable =
        p.type === PARTITION_TABLE_TYPE && p.subtype === SUBTYPES[PARTITION_TABLE_TYPE]!.primary;
      if (
        p.offset < opts.offsetPartTable + PARTITION_TABLE_SIZE &&
        !(isPrimaryBootloader || isPrimaryPartitionTable)
      ) {
        throw new ValidationError(
          `partition '${p.name}' offset 0x${p.offset.toString(16)} is below 0x${(opts.offsetPartTable + PARTITION_TABLE_SIZE).toString(16)}`,
        );
      }
      if (last && p.offset < last.offset + last.size) {
        throw new ValidationError(
          `partition '${p.name}' at 0x${p.offset.toString(16)} overlaps '${last.name}' (0x${last.offset.toString(16)}-0x${(last.offset + last.size - 1).toString(16)})`,
        );
      }
      last = p;
    }

    // otadata must be unique and 0x2000.
    const otaData = sorted.filter(
      (p) => p.type === DATA_TYPE && p.subtype === SUBTYPES[DATA_TYPE]!.ota,
    );
    if (otaData.length > 1) {
      throw new ValidationError('multiple otadata partitions defined; only one allowed');
    }
    if (otaData.length === 1 && otaData[0]!.size !== 0x2000) {
      throw new ValidationError('otadata partition must have size 0x2000');
    }

    const teeOta = sorted.filter(
      (p) => p.type === DATA_TYPE && p.subtype === SUBTYPES[DATA_TYPE]!.tee_ota,
    );
    if (teeOta.length > 1) throw new ValidationError('multiple TEE otadata partitions defined');
    if (teeOta.length === 1 && teeOta[0]!.size !== 0x2000) {
      throw new ValidationError('TEE otadata partition must have size 0x2000');
    }

    // Flash-size fit.
    if (opts.flashSize && sorted.length > 0) {
      const last = sorted[sorted.length - 1]!;
      const totalEnd = last.offset + last.size;
      if (totalEnd > opts.flashSize) {
        throw new ValidationError(
          `partitions occupy 0x${totalEnd.toString(16)} bytes, exceeding configured flash size 0x${opts.flashSize.toString(16)}`,
        );
      }
    }
  }
}

function hex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
}

export { PARTITION_ENTRY_SIZE, PARTITION_MAGIC, MAX_PARTITION_LENGTH, MD5_PARTITION_BEGIN };
export { parseEntry, encodeEntry } from './entry.js';
export { TYPES, SUBTYPES } from './constants.js';
