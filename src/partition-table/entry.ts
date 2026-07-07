import { BinaryReader, bytesEqual, padOrTruncate, utf8Encode } from '../common/binary.js';
import {
  createWarningSink,
  emitWarning,
  formatWarning,
  type WarningSink,
} from '../common/diagnostics.js';
import { InputError, ValidationError } from '../common/errors.js';
import {
  APP_TYPE,
  BOOTLOADER_TYPE,
  DATA_TYPE,
  DEFAULT_OFFSET_PART_TABLE,
  FLAG_BITS,
  getAlignmentOffsetForType,
  getPtypeName,
  getSubtypeName,
  getSubtypeMap,
  NVS_RW_MIN_PARTITION_SIZE,
  PARTITION_ENTRY_SIZE,
  PARTITION_MAGIC,
  PARTITION_TABLE_SIZE,
  PARTITION_TABLE_TYPE,
  parseInteger,
  type ExtraPartitionSubtypes,
  SUBTYPES,
  TYPES,
} from './constants.js';

export interface ParsedPartition {
  name: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
  encrypted: boolean;
  readonly: boolean;
}

export interface ParseEntryOptions {
  bestEffort?: boolean;
  subject?: string;
  onWarning?: (warning: ReturnType<typeof formatWarning>) => void;
  warningSink?: Pick<WarningSink, 'warnings' | 'onWarning'>;
}

/**
 * Parse a 32-byte partition entry. Throws if magic bytes don't match.
 */
export function parseEntry(data: Uint8Array, opts: ParseEntryOptions = {}): ParsedPartition {
  if (data.length !== PARTITION_ENTRY_SIZE) {
    throw new InputError(`Partition entry must be 32 bytes, got ${data.length}`);
  }
  const warningSink = opts.warningSink ?? createWarningSink(opts.onWarning);
  const subject = opts.subject ?? 'partition entry';
  const reader = new BinaryReader(data);
  const magic = reader.bytes(2);
  if (!bytesEqual(magic, PARTITION_MAGIC)) {
    throw new InputError(`Invalid magic bytes for partition entry: ${hex(magic)}`);
  }
  const type = reader.u8();
  const subtype = reader.u8();
  const offset = reader.u32();
  const size = reader.u32();
  const nameBytes = reader.bytes(16);
  const flags = reader.u32();
  const name = decodePartitionName(nameBytes, warningSink, subject, opts.bestEffort ?? false);
  const knownFlagsMask = (1 << FLAG_BITS.encrypted) | (1 << FLAG_BITS.readonly);
  const unknownFlags = flags & ~knownFlagsMask;
  if (unknownFlags !== 0) {
    emitWarning(
      warningSink,
      formatWarning(
        'PartitionTable',
        subject,
        `entry contains unknown flag bits 0x${unknownFlags.toString(16)}; newer binary format or non-IDF extension`,
      ),
    );
  }
  return {
    name,
    type,
    subtype,
    offset,
    size,
    encrypted: !!(flags & (1 << FLAG_BITS.encrypted)),
    readonly: !!(flags & (1 << FLAG_BITS.readonly)),
  };
}

function validateU8(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new InputError(`Partition ${field} must be an integer in range 0..0xff, got ${value}`);
  }
}

function validateU32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new InputError(
      `Partition ${field} must be an integer in range 0..0xffffffff, got ${value}`,
    );
  }
}

export function encodeEntry(p: ParsedPartition): Uint8Array {
  const encodedName = utf8Encode(p.name);
  if (encodedName.length > 16) {
    throw new InputError(`Partition name '${p.name}' is longer than 16 bytes when UTF-8 encoded`);
  }
  validateU8(p.type, 'type');
  validateU8(p.subtype, 'subtype');
  validateU32(p.offset, 'offset');
  validateU32(p.size, 'size');
  const out = new Uint8Array(PARTITION_ENTRY_SIZE);
  const view = new DataView(out.buffer);
  out.set(PARTITION_MAGIC, 0);
  view.setUint8(2, p.type);
  view.setUint8(3, p.subtype);
  view.setUint32(4, p.offset, true);
  view.setUint32(8, p.size, true);
  const nameBytes = padOrTruncate(encodedName, 16, 0);
  out.set(nameBytes, 12);
  let flags = 0;
  if (p.encrypted) flags |= 1 << FLAG_BITS.encrypted;
  if (p.readonly) flags |= 1 << FLAG_BITS.readonly;
  view.setUint32(28, flags, true);
  return out;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
}

function decodePartitionName(
  nameBytes: Uint8Array,
  warningSink: Pick<WarningSink, 'warnings' | 'onWarning'> | undefined,
  subject: string,
  bestEffort: boolean,
): string {
  const nul = nameBytes.indexOf(0);
  const bytes = nul >= 0 ? nameBytes.subarray(0, nul) : nameBytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (bestEffort) {
      emitWarning(
        warningSink,
        formatWarning(
          'PartitionTable',
          subject,
          `partition name contains invalid UTF-8 bytes (${hex(bytes)}); decoded with replacement characters`,
        ),
      );
      return new TextDecoder('utf-8').decode(bytes);
    }
    throw new InputError(`Invalid UTF-8 bytes in partition name: ${hex(bytes)}`);
  }
}

export function ptypeToString(p: ParsedPartition): string {
  return getPtypeName(p.type) ?? String(p.type);
}

export function subtypeToString(p: ParsedPartition): string {
  return getSubtypeName(p.type, p.subtype) ?? String(p.subtype);
}

export interface VerifyContext {
  offsetPartTable: number;
  primaryBootloaderOffset: number | null;
  secure: 'none' | 'v1' | 'v2';
}

export function verifyEntry(p: ParsedPartition, ctx: VerifyContext): void {
  const offsetAlign = getAlignmentOffsetForType(p.type);
  if (p.offset % offsetAlign !== 0) {
    throw new ValidationError(
      `Partition '${p.name}' offset 0x${p.offset.toString(16)} is not aligned to 0x${offsetAlign.toString(16)}`,
    );
  }
  if (p.type === APP_TYPE) {
    const sizeAlign = ctx.secure === 'v1' ? 0x10000 : 0x1000;
    if (p.size % sizeAlign !== 0) {
      throw new ValidationError(
        `Partition '${p.name}' size 0x${p.size.toString(16)} is not aligned to 0x${sizeAlign.toString(16)}`,
      );
    }
  }
  if (
    p.type === DATA_TYPE &&
    (p.subtype === SUBTYPES[DATA_TYPE]!.ota || p.subtype === SUBTYPES[DATA_TYPE]!.coredump) &&
    p.readonly
  ) {
    throw new ValidationError(
      `Partition '${p.name}' subtype 0x${p.subtype.toString(16)} is always read-write and cannot be readonly`,
    );
  }
  if (
    p.type === DATA_TYPE &&
    p.subtype === SUBTYPES[DATA_TYPE]!.nvs &&
    !p.readonly &&
    p.size < NVS_RW_MIN_PARTITION_SIZE
  ) {
    throw new ValidationError(
      `NVS partition '${p.name}' size 0x${p.size.toString(16)} is below the r/w minimum 0x${NVS_RW_MIN_PARTITION_SIZE.toString(16)}; mark it readonly or grow it.`,
    );
  }
  void ctx;
}

/**
 * Parse a single CSV row into a (possibly partial) partition. Offsets and sizes
 * may come back as `null` to be resolved later.
 */
export function parseCsvRow(
  line: string,
  lineNo: number,
  ctx: {
    offsetPartTable: number;
    primaryBootloaderOffset: number | null;
    recoveryBootloaderOffset: number | null;
    extraSubtypes?: ExtraPartitionSubtypes;
  },
): {
  name: string;
  type: number;
  subtype: number;
  offset: number | null;
  size: number | null;
  encrypted: boolean;
  readonly: boolean;
  lineNo: number;
} {
  const fields = (line + ',,,,').split(',').map((f) => f.trim());
  const [nameF, typeF, subtypeF, offsetF, sizeF, flagsF] = fields;
  if (!nameF) throw new InputError(`CSV line ${lineNo}: empty name`);
  if (!typeF) throw new InputError(`CSV line ${lineNo}: empty type`);

  const type = parseInteger(typeF, TYPES);
  let subtype: number;
  if (subtypeF === '') {
    if (type === APP_TYPE) {
      throw new InputError(`CSV line ${lineNo}: app partition cannot have an empty subtype`);
    }
    subtype = SUBTYPES[DATA_TYPE]!.undefined!;
  } else {
    subtype = parseInteger(subtypeF!, getSubtypeMap(type, ctx.extraSubtypes));
  }

  // Offset handling (bootloader / primary partition table have fixed offsets).
  let offset: number | null;
  if (type === BOOTLOADER_TYPE && subtype === SUBTYPES[BOOTLOADER_TYPE]!.primary) {
    if (ctx.primaryBootloaderOffset === null) {
      throw new InputError(
        `CSV line ${lineNo}: primary bootloader offset required; pass primaryBootloaderOffset in options`,
      );
    }
    offset = ctx.primaryBootloaderOffset;
  } else if (type === BOOTLOADER_TYPE && subtype === SUBTYPES[BOOTLOADER_TYPE]!.recovery) {
    if (ctx.recoveryBootloaderOffset === null) {
      throw new InputError(
        `CSV line ${lineNo}: recovery bootloader offset required; pass recoveryBootloaderOffset in options`,
      );
    }
    offset = ctx.recoveryBootloaderOffset;
  } else if (type === PARTITION_TABLE_TYPE && subtype === SUBTYPES[PARTITION_TABLE_TYPE]!.primary) {
    offset = ctx.offsetPartTable;
  } else if (!offsetF) {
    offset = null;
  } else {
    offset = parseInteger(offsetF);
  }

  // Size handling.
  let size: number | null;
  if (type === BOOTLOADER_TYPE) {
    if (ctx.primaryBootloaderOffset === null) {
      throw new InputError(
        `CSV line ${lineNo}: primary bootloader offset required to compute bootloader size`,
      );
    }
    size = ctx.offsetPartTable - ctx.primaryBootloaderOffset;
  } else if (type === PARTITION_TABLE_TYPE) {
    size = PARTITION_TABLE_SIZE;
  } else if (!sizeF) {
    size = null;
  } else {
    size = parseInteger(sizeF);
  }

  let encrypted = false;
  let readonly = false;
  if (flagsF) {
    for (const flag of flagsF.split(':')) {
      if (flag === '') continue;
      if (flag === 'encrypted') encrypted = true;
      else if (flag === 'readonly') readonly = true;
      else throw new InputError(`CSV line ${lineNo}: unknown flag '${flag}'`);
    }
  }

  return { name: nameF!, type, subtype, offset, size, encrypted, readonly, lineNo };
}

export function partitionToCsv(
  p: ParsedPartition,
  simple = false,
  extraSubtypes?: ExtraPartitionSubtypes,
): string {
  const addrFormat = (a: number, includeSizes: boolean): string => {
    if (!simple && includeSizes) {
      if (a % 0x100000 === 0) return `${a / 0x100000}M`;
      if (a % 0x400 === 0) return `${a / 0x400}K`;
    }
    return `0x${a.toString(16)}`;
  };
  const flags: string[] = [];
  if (p.encrypted) flags.push('encrypted');
  if (p.readonly) flags.push('readonly');
  return [
    p.name,
    simple ? String(p.type) : (getPtypeName(p.type) ?? String(p.type)),
    simple
      ? String(p.subtype)
      : (getSubtypeName(p.type, p.subtype, extraSubtypes) ?? String(p.subtype)),
    addrFormat(p.offset, false),
    addrFormat(p.size, true),
    flags.join(':'),
  ].join(',');
}

// Keep DEFAULT_OFFSET_PART_TABLE re-exported for convenience.
export { DEFAULT_OFFSET_PART_TABLE };
