import { describe, it, expect } from 'vitest';
import { crc32, crc32Nvs } from '../src/common/crc32.js';
import { md5 } from '../src/common/md5.js';
import {
  BinaryReader,
  BinaryWriter,
  asciiEncode,
  bytesEqual,
  padOrTruncate,
} from '../src/common/binary.js';
import { ParseError } from '../src/common/errors.js';

describe('crc32', () => {
  it('matches well-known vectors', () => {
    // Matches Python's zlib.crc32
    expect(crc32(new Uint8Array())).toBe(0x00000000);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(
      0x414fa339,
    );
  });

  it('crc32Nvs matches zlib.crc32(data, 0xFFFFFFFF)', () => {
    // zlib.crc32(b'hello', 0xFFFFFFFF) == 0x0fcdae64
    expect(crc32Nvs(new TextEncoder().encode('hello'))).toBe(0x0fcdae64);
  });
});

describe('md5', () => {
  it('matches md5 test vector', () => {
    const h = md5(new TextEncoder().encode(''));
    expect(Buffer.from(h).toString('hex')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    const h2 = md5(new TextEncoder().encode('abc'));
    expect(Buffer.from(h2).toString('hex')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});

describe('BinaryWriter/Reader', () => {
  it('roundtrips common integer types', () => {
    const w = new BinaryWriter();
    w.writeU8(0x12)
      .writeU16(0x3456)
      .writeU32(0x789abcde)
      .writeI32(-1)
      .writeU64(0x1122334455667788n)
      .writeBytes(asciiEncode('hi'));
    const bytes = w.toBytes();
    const r = new BinaryReader(bytes);
    expect(r.u8()).toBe(0x12);
    expect(r.u16()).toBe(0x3456);
    expect(r.u32()).toBe(0x789abcde);
    expect(r.i32()).toBe(-1);
    expect(r.u64()).toBe(0x1122334455667788n);
    expect(Array.from(r.bytes(2))).toEqual([0x68, 0x69]);
  });

  it('padOrTruncate pads with zeros', () => {
    expect(Array.from(padOrTruncate(new Uint8Array([1, 2]), 4))).toEqual([1, 2, 0, 0]);
    expect(Array.from(padOrTruncate(new Uint8Array([1, 2, 3, 4, 5]), 3))).toEqual([1, 2, 3]);
  });
});

describe('BinaryReader - boundary errors', () => {
  it('seek throws ParseError on negative offset', () => {
    const r = new BinaryReader(new Uint8Array(8));
    expect(() => r.seek(-1)).toThrow(ParseError);
  });

  it('seek throws ParseError on offset beyond length', () => {
    const r = new BinaryReader(new Uint8Array(8));
    expect(() => r.seek(9)).toThrow(ParseError);
  });

  it('seek to exact length is allowed (EOF)', () => {
    const r = new BinaryReader(new Uint8Array(8));
    expect(() => r.seek(8)).not.toThrow();
  });

  it('read past end throws ParseError', () => {
    const r = new BinaryReader(new Uint8Array(4));
    r.seek(3);
    expect(() => r.u16()).toThrow(ParseError);
  });

  it('u8 at EOF throws ParseError', () => {
    const r = new BinaryReader(new Uint8Array(2));
    r.seek(2);
    expect(() => r.u8()).toThrow(ParseError);
  });

  it('peekBytes throws ParseError on overflow', () => {
    const r = new BinaryReader(new Uint8Array(4));
    expect(() => r.peekBytes(5)).toThrow(ParseError);
  });

  it('peekBytes with explicit offset', () => {
    const data = new Uint8Array([10, 20, 30, 40]);
    const r = new BinaryReader(data);
    expect(Array.from(r.peekBytes(2, 1))).toEqual([20, 30]);
  });

  it('skip delegates to seek and can throw', () => {
    const r = new BinaryReader(new Uint8Array(4));
    r.seek(3);
    expect(() => r.skip(2)).toThrow(ParseError);
  });

  it('supports sub-range via byteOffset and byteLength', () => {
    const data = new Uint8Array([0, 0, 0x12, 0x34, 0, 0]);
    const r = new BinaryReader(data, 2, 2);
    expect(r.length).toBe(2);
    expect(r.u8()).toBe(0x12);
    expect(r.u8()).toBe(0x34);
    expect(() => r.u8()).toThrow(ParseError);
  });
});

describe('asciiEncode - error path', () => {
  it('throws ParseError on non-ASCII character', () => {
    expect(() => asciiEncode('hello')).not.toThrow();
    expect(() => asciiEncode('中文')).toThrow(ParseError);
    expect(() => asciiEncode('café')).toThrow(ParseError);
  });
});

describe('bytesEqual', () => {
  it('returns true for identical arrays', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('returns false for different lengths', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('returns false for same length but different content', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('returns true for empty arrays', () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});
