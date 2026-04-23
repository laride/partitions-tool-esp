import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDir, createFile } from '../src/common/virtual-fs.js';
import { generate, parse } from '../src/spiffs/index.js';

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
});

describe('SPIFFS - writer edge cases', () => {
  it('throws on imageSize not aligned to blockSize', () => {
    const source = createDir('root', [createFile('a.txt', new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 5000, source, blockSize: 4096 })).toThrow(
      /multiple of block size/,
    );
  });

  it('throws on file name too long', () => {
    const longName = 'a'.repeat(256) + '.txt';
    const source = createDir('root', [createFile(longName, new Uint8Array([1]))]);
    expect(() => generate({ imageSize: 65536, source })).toThrow(/too long/);
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
});
