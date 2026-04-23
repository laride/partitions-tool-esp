import {
  asciiDecode,
  asciiEncode,
  BinaryReader,
  bytesEqual,
  padOrTruncate,
  trimNull,
} from '../common/binary.js';
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
  NVS_RW_MIN_PARTITION_SIZE,
  PARTITION_ENTRY_SIZE,
  PARTITION_MAGIC,
  PARTITION_TABLE_SIZE,
  PARTITION_TABLE_TYPE,
  parseInteger,
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

/**
 * Parse a 32-byte partition entry. Throws if magic bytes don't match.
 */
export function parseEntry(data: Uint8Array): ParsedPartition {
  if (data.length !== PARTITION_ENTRY_SIZE) {
    throw new InputError(`Partition entry must be 32 bytes, got ${data.length}`);
  }
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
  const name = trimNull(asciiDecode(nameBytes));
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

export function encodeEntry(p: ParsedPartition): Uint8Array {
  if (p.name.length > 16) {
    throw new InputError(`Partition name '${p.name}' is longer than 16 characters`);
  }
  const out = new Uint8Array(PARTITION_ENTRY_SIZE);
  const view = new DataView(out.buffer);
  out.set(PARTITION_MAGIC, 0);
  view.setUint8(2, p.type & 0xff);
  view.setUint8(3, p.subtype & 0xff);
  view.setUint32(4, p.offset >>> 0, true);
  view.setUint32(8, p.size >>> 0, true);
  const nameBytes = padOrTruncate(asciiEncode(p.name), 16, 0);
  out.set(nameBytes, 12);
  let flags = 0;
  if (p.encrypted) flags |= 1 << FLAG_BITS.encrypted;
  if (p.readonly) flags |= 1 << FLAG_BITS.readonly;
  view.setUint32(28, flags >>> 0, true);
  return out;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
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
}

export function verifyEntry(p: ParsedPartition, ctx: VerifyContext): void {
  const offsetAlign = getAlignmentOffsetForType(p.type);
  if (p.offset % offsetAlign !== 0) {
    throw new ValidationError(
      `Partition '${p.name}' offset 0x${p.offset.toString(16)} is not aligned to 0x${offsetAlign.toString(16)}`,
    );
  }
  if (p.type === APP_TYPE) {
    // No secure-boot scenarios modeled yet => app must be 4K-aligned in size.
    if (p.size % 0x1000 !== 0) {
      throw new ValidationError(
        `Partition '${p.name}' size 0x${p.size.toString(16)} is not aligned to 0x1000`,
      );
    }
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
  ctx: { offsetPartTable: number; primaryBootloaderOffset: number | null },
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
    subtype = parseInteger(subtypeF!, SUBTYPES[type] ?? {});
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

export function partitionToCsv(p: ParsedPartition, simple = false): string {
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
    simple ? String(p.subtype) : (getSubtypeName(p.type, p.subtype) ?? String(p.subtype)),
    addrFormat(p.offset, false),
    addrFormat(p.size, true),
    flags.join(':'),
  ].join(',');
}

// Keep DEFAULT_OFFSET_PART_TABLE re-exported for convenience.
export { DEFAULT_OFFSET_PART_TABLE };
