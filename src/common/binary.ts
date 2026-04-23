import { ParseError } from './errors.js';

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function filledBytes(len: number, value: number): Uint8Array {
  const b = new Uint8Array(len);
  b.fill(value & 0xff);
  return b;
}

export class BinaryReader {
  readonly view: DataView;
  offset = 0;

  constructor(
    public readonly data: Uint8Array,
    byteOffset = 0,
    byteLength?: number,
  ) {
    const end = byteLength === undefined ? data.byteLength - byteOffset : byteLength;
    this.view = new DataView(data.buffer, data.byteOffset + byteOffset, end);
  }

  get length(): number {
    return this.view.byteLength;
  }

  get remaining(): number {
    return this.length - this.offset;
  }

  seek(offset: number): this {
    if (offset < 0 || offset > this.length) throw new ParseError(`seek out of range: ${offset}`);
    this.offset = offset;
    return this;
  }

  skip(n: number): this {
    return this.seek(this.offset + n);
  }

  private ensure(n: number): void {
    if (this.offset + n > this.length) {
      throw new ParseError(
        `read past end of buffer (offset=${this.offset} need=${n} length=${this.length})`,
      );
    }
  }

  u8(): number {
    this.ensure(1);
    return this.view.getUint8(this.offset++);
  }

  i8(): number {
    this.ensure(1);
    return this.view.getInt8(this.offset++);
  }

  u16(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u16be(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u32be(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    this.ensure(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.ensure(n);
    const out = this.data.subarray(
      this.view.byteOffset - this.data.byteOffset + this.offset,
      this.view.byteOffset - this.data.byteOffset + this.offset + n,
    );
    this.offset += n;
    return new Uint8Array(out);
  }

  peekBytes(n: number, offset = this.offset): Uint8Array {
    if (offset + n > this.length) throw new ParseError('peek past end');
    const start = this.view.byteOffset - this.data.byteOffset + offset;
    return new Uint8Array(this.data.subarray(start, start + n));
  }
}

export class BinaryWriter {
  private chunks: Uint8Array[] = [];
  private total = 0;

  get length(): number {
    return this.total;
  }

  writeU8(v: number): this {
    const b = new Uint8Array(1);
    b[0] = v & 0xff;
    return this.push(b);
  }

  writeI8(v: number): this {
    const b = new Uint8Array(1);
    new DataView(b.buffer).setInt8(0, v);
    return this.push(b);
  }

  writeU16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return this.push(b);
  }

  writeI16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, v, true);
    return this.push(b);
  }

  writeU32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return this.push(b);
  }

  writeI32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    return this.push(b);
  }

  writeU64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return this.push(b);
  }

  writeI64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, true);
    return this.push(b);
  }

  writeBytes(b: Uint8Array): this {
    return this.push(new Uint8Array(b));
  }

  writeFill(count: number, value: number): this {
    return this.push(filledBytes(count, value));
  }

  private push(b: Uint8Array): this {
    this.chunks.push(b);
    this.total += b.length;
    return this;
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

export function padOrTruncate(b: Uint8Array, size: number, fill = 0): Uint8Array {
  if (b.length === size) return b;
  if (b.length > size) return b.slice(0, size);
  const out = new Uint8Array(size);
  out.fill(fill);
  out.set(b, 0);
  return out;
}

export function asciiEncode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) throw new ParseError(`non-ASCII character in '${s}'`);
    out[i] = code;
  }
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(b);
}

export function asciiDecode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]!);
  return out;
}

export function trimNull(s: string): string {
  const idx = s.indexOf('\u0000');
  return idx < 0 ? s : s.slice(0, idx);
}
