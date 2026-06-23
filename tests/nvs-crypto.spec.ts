import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate,
  parse,
  parseCSV,
  generateNvsKey,
  deriveNvsKeyFromHmac,
  serializeNvsKeyPartition,
  parseNvsKeyPartition,
  encryptNvsPartition,
  decryptNvsPartition,
  NVS_KEY_SIZE,
  type NvsEncryptionKey,
} from '../src/nvs/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

function loadFixtureKey(): NvsEncryptionKey {
  const raw = new Uint8Array(readFileSync(join(fixtures, 'nvs_enc_test_key.bin')));
  return { eky: raw.subarray(0, 32), tky: raw.subarray(32, 64) };
}

describe('NVS Encryption - key management', () => {
  it('generateNvsKey produces 64 bytes total', () => {
    const key = generateNvsKey();
    expect(key.eky.length).toBe(32);
    expect(key.tky.length).toBe(32);
  });

  it('serializeNvsKeyPartition/parseNvsKeyPartition round-trip', () => {
    const key = generateNvsKey();
    const bin = serializeNvsKeyPartition(key);
    expect(bin.length).toBe(4096);
    const parsed = parseNvsKeyPartition(bin);
    expect(parsed.eky).toEqual(key.eky);
    expect(parsed.tky).toEqual(key.tky);
  });

  it('parseNvsKeyPartition rejects corrupted CRC', () => {
    const key = generateNvsKey();
    const bin = serializeNvsKeyPartition(key);
    bin[64] ^= 0x01;
    expect(() => parseNvsKeyPartition(bin)).toThrow('CRC mismatch');
  });

  it('deriveNvsKeyFromHmac produces deterministic keys', () => {
    const hmacKey = new Uint8Array(32).fill(0xab);
    const k1 = deriveNvsKeyFromHmac(hmacKey);
    const k2 = deriveNvsKeyFromHmac(hmacKey);
    expect(k1.eky).toEqual(k2.eky);
    expect(k1.tky).toEqual(k2.tky);
    expect(k1.eky).not.toEqual(k1.tky);
  });
});

describe('NVS Encryption - key length validation', () => {
  const validKey = (): NvsEncryptionKey => ({
    eky: new Uint8Array(NVS_KEY_SIZE).fill(0xaa),
    tky: new Uint8Array(NVS_KEY_SIZE).fill(0xbb),
  });

  it.each([
    ['short eky', 16, NVS_KEY_SIZE],
    ['short tky', NVS_KEY_SIZE, 16],
    ['long eky', 40, NVS_KEY_SIZE],
    ['long tky', NVS_KEY_SIZE, 40],
  ] as const)('serializeNvsKeyPartition rejects %s', (_label, ekyLen, tkyLen) => {
    const key = { eky: new Uint8Array(ekyLen), tky: new Uint8Array(tkyLen) };
    expect(() => serializeNvsKeyPartition(key)).toThrow(/must be 32 bytes/);
  });

  it.each([
    ['short eky', 16, NVS_KEY_SIZE],
    ['short tky', NVS_KEY_SIZE, 16],
    ['long eky', 40, NVS_KEY_SIZE],
    ['long tky', NVS_KEY_SIZE, 40],
  ] as const)('encryptNvsPartition rejects %s', (_label, ekyLen, tkyLen) => {
    const key = { eky: new Uint8Array(ekyLen), tky: new Uint8Array(tkyLen) };
    const image = new Uint8Array(4096).fill(0xff);
    expect(() => encryptNvsPartition(image, key)).toThrow(/must be 32 bytes/);
  });

  it.each([
    ['short eky', 16, NVS_KEY_SIZE],
    ['short tky', NVS_KEY_SIZE, 16],
    ['long eky', 40, NVS_KEY_SIZE],
    ['long tky', NVS_KEY_SIZE, 40],
  ] as const)('decryptNvsPartition rejects %s', (_label, ekyLen, tkyLen) => {
    const key = { eky: new Uint8Array(ekyLen), tky: new Uint8Array(tkyLen) };
    const image = new Uint8Array(4096).fill(0xff);
    expect(() => decryptNvsPartition(image, key)).toThrow(/must be 32 bytes/);
  });

  it('accepts valid 32-byte eky and tky', () => {
    const key = validKey();
    expect(() => serializeNvsKeyPartition(key)).not.toThrow();
    const image = new Uint8Array(4096).fill(0xff);
    expect(() => encryptNvsPartition(image, key)).not.toThrow();
    expect(() => decryptNvsPartition(image, key)).not.toThrow();
  });
});

describe('NVS Encryption - encrypt/decrypt round-trip', () => {
  it('encrypt then decrypt produces original plaintext', () => {
    const csv = readFileSync(join(fixtures, 'nvs_enc_test.csv'), 'utf8');
    const entries = parseCSV(csv);
    const plain = generate(entries, { size: 0x4000 });
    const key = generateNvsKey();
    const encrypted = encryptNvsPartition(plain, key);
    expect(encrypted).not.toEqual(plain);
    const decrypted = decryptNvsPartition(encrypted, key);
    expect(decrypted).toEqual(plain);
  });

  it('generate with encryptionKey option works', () => {
    const csv = readFileSync(join(fixtures, 'nvs_enc_test.csv'), 'utf8');
    const entries = parseCSV(csv);
    const key = generateNvsKey();
    const encrypted = generate(entries, { size: 0x4000, encryptionKey: key });
    const plain = generate(entries, { size: 0x4000 });
    expect(encrypted).not.toEqual(plain);
    const decrypted = decryptNvsPartition(encrypted, key);
    expect(decrypted).toEqual(plain);
  });

  it('parse with decryptionKey option recovers entries', () => {
    const csv = readFileSync(join(fixtures, 'nvs_enc_test.csv'), 'utf8');
    const entries = parseCSV(csv);
    const key = generateNvsKey();
    const encrypted = generate(entries, { size: 0x4000, encryptionKey: key });
    const dump = parse(encrypted, { decryptionKey: key });
    const active = dump.pages.find((p) => p.header.status === 'Active');
    expect(active).toBeDefined();
    const written = active!.entries.filter((e) => e.state === 'Written');
    expect(written.length).toBeGreaterThanOrEqual(3);
    const ns = written.find((e) => e.key === 'test_ns');
    expect(ns).toBeDefined();
  });
});

describe('NVS Encryption - IDF compatibility', () => {
  it('matches esp_idf_nvs_partition_gen encrypted output byte-for-byte', () => {
    const csv = readFileSync(join(fixtures, 'nvs_enc_test.csv'), 'utf8');
    const golden = new Uint8Array(readFileSync(join(fixtures, 'nvs_enc_encrypted.bin')));
    const key = loadFixtureKey();
    const entries = parseCSV(csv);
    const encrypted = generate(entries, { size: golden.byteLength, encryptionKey: key });

    expect(encrypted.byteLength).toBe(golden.byteLength);
    const diff: number[] = [];
    for (let i = 0; i < encrypted.byteLength; i++) {
      if (encrypted[i] !== golden[i]) diff.push(i);
      if (diff.length > 20) break;
    }
    expect(diff, `diff at offsets ${diff.join(',')}`).toEqual([]);
  });

  it('decrypts IDF-generated encrypted partition correctly', () => {
    const goldenEncrypted = new Uint8Array(readFileSync(join(fixtures, 'nvs_enc_encrypted.bin')));
    const goldenPlain = new Uint8Array(readFileSync(join(fixtures, 'nvs_enc_plain.bin')));
    const key = loadFixtureKey();
    const decrypted = decryptNvsPartition(goldenEncrypted, key);
    expect(decrypted).toEqual(goldenPlain);
  });

  it('parse can decode IDF-generated encrypted partition', () => {
    const goldenEncrypted = new Uint8Array(readFileSync(join(fixtures, 'nvs_enc_encrypted.bin')));
    const key = loadFixtureKey();
    const dump = parse(goldenEncrypted, { decryptionKey: key });
    const active = dump.pages.find((p) => p.header.status === 'Active');
    expect(active).toBeDefined();
    const written = active!.entries.filter((e) => e.state === 'Written');
    const u8Entry = written.find((e) => e.key === 'u8_key');
    expect(u8Entry).toBeDefined();
    expect(u8Entry!.data).toEqual({ kind: 'int', value: 42n });
  });
});
