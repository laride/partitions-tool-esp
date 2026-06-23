import { unsafe } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { crc32Nvs } from '../common/crc32.js';
import { ENTRY_SIZE, FIRST_ENTRY_OFFSET, PAGE_SIZE } from './constants.js';

export const NVS_KEY_SIZE = 32;
export const NVS_XTS_KEY_SIZE = 64;
const AES_BLOCK_SIZE = 16;

/** AES-256-XTS encryption key pair for NVS partitions. */
export interface NvsEncryptionKey {
  /** Encryption key (`eky`); must be exactly {@link NVS_KEY_SIZE} (32) bytes. */
  eky: Uint8Array;
  /** Tweak key (`tky`); must be exactly {@link NVS_KEY_SIZE} (32) bytes. */
  tky: Uint8Array;
}

function assertNvsKey(key: NvsEncryptionKey): void {
  if (key.eky.length !== NVS_KEY_SIZE) {
    throw new Error(`NVS encryption key eky must be ${NVS_KEY_SIZE} bytes, got ${key.eky.length}`);
  }
  if (key.tky.length !== NVS_KEY_SIZE) {
    throw new Error(`NVS encryption key tky must be ${NVS_KEY_SIZE} bytes, got ${key.tky.length}`);
  }
}

const HMAC_EKEY_SEED = new Uint8Array(32);
const HMAC_TKEY_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i += 4) {
  HMAC_EKEY_SEED[i] = 0x5a;
  HMAC_EKEY_SEED[i + 1] = 0x5a;
  HMAC_EKEY_SEED[i + 2] = 0xbe;
  HMAC_EKEY_SEED[i + 3] = 0xae;
  HMAC_TKEY_SEED[i] = 0xa5;
  HMAC_TKEY_SEED[i + 1] = 0xa5;
  HMAC_TKEY_SEED[i + 2] = 0xde;
  HMAC_TKEY_SEED[i + 3] = 0xce;
}

export function generateNvsKey(): NvsEncryptionKey {
  return { eky: randomBytes(NVS_KEY_SIZE), tky: randomBytes(NVS_KEY_SIZE) };
}

export function deriveNvsKeyFromHmac(hmacKey: Uint8Array): NvsEncryptionKey {
  if (hmacKey.length !== NVS_KEY_SIZE) {
    throw new Error(`HMAC key must be ${NVS_KEY_SIZE} bytes`);
  }
  const eky = hmac(sha256, hmacKey, HMAC_EKEY_SEED);
  const tky = hmac(sha256, hmacKey, HMAC_TKEY_SEED);
  return { eky: new Uint8Array(eky), tky: new Uint8Array(tky) };
}

/**
 * Serialize an NVS encryption key into the NVS keys partition format:
 * 64 bytes key (eky + tky) + 4 bytes CRC32, padded to PAGE_SIZE.
 *
 * @param key - `eky` and `tky` must each be exactly {@link NVS_KEY_SIZE} (32) bytes.
 */
export function serializeNvsKeyPartition(key: NvsEncryptionKey): Uint8Array {
  assertNvsKey(key);
  const buf = new Uint8Array(PAGE_SIZE).fill(0xff);
  buf.set(key.eky, 0);
  buf.set(key.tky, NVS_KEY_SIZE);
  const combined = new Uint8Array(NVS_XTS_KEY_SIZE);
  combined.set(key.eky, 0);
  combined.set(key.tky, NVS_KEY_SIZE);
  const crc = crc32Nvs(combined) >>> 0;
  new DataView(buf.buffer).setUint32(NVS_XTS_KEY_SIZE, crc, true);
  return buf;
}

/**
 * Parse a key from an NVS keys partition binary (first 64 bytes + CRC validation).
 */
export function parseNvsKeyPartition(data: Uint8Array): NvsEncryptionKey {
  if (data.length < NVS_XTS_KEY_SIZE + 4) {
    throw new Error('NVS key partition too small');
  }
  const eky = new Uint8Array(data.subarray(0, NVS_KEY_SIZE));
  const tky = new Uint8Array(data.subarray(NVS_KEY_SIZE, NVS_XTS_KEY_SIZE));
  const storedCrc = new DataView(data.buffer, data.byteOffset).getUint32(NVS_XTS_KEY_SIZE, true);
  const combined = new Uint8Array(NVS_XTS_KEY_SIZE);
  combined.set(eky, 0);
  combined.set(tky, NVS_KEY_SIZE);
  const computedCrc = crc32Nvs(combined) >>> 0;
  if (storedCrc !== computedCrc) {
    throw new Error(
      `NVS key CRC mismatch (stored=0x${storedCrc.toString(16)}, computed=0x${computedCrc.toString(16)})`,
    );
  }
  return { eky, tky };
}

/**
 * Multiply tweak by alpha in GF(2^128) — left-shift by 1 bit with
 * conditional XOR of the irreducible polynomial (0x87 at LSB byte).
 */
function gfMul(tweak: Uint8Array): void {
  let carry = 0;
  for (let i = 0; i < AES_BLOCK_SIZE; i++) {
    const next = (tweak[i]! >> 7) & 1;
    tweak[i] = ((tweak[i]! << 1) | carry) & 0xff;
    carry = next;
  }
  if (carry) tweak[0]! ^= 0x87;
}

function xorBlocks(dst: Uint8Array, src: Uint8Array, offset: number): void {
  for (let i = 0; i < AES_BLOCK_SIZE; i++) {
    dst[i]! ^= src[offset + i]!;
  }
}

/**
 * Encrypt a single NVS data unit (32 bytes = 2 AES blocks) using AES-256-XTS.
 * Tweak is pre-computed as 16 bytes.
 */
function xtsEncryptUnit(
  dataKeyExp: Uint32Array,
  tweakKeyExp: Uint32Array,
  tweak: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(data.length);
  out.set(data);

  const t = new Uint8Array(AES_BLOCK_SIZE);
  t.set(tweak);
  const encTweak = unsafe.encryptBlock(tweakKeyExp, t);
  if (encTweak instanceof Uint8Array) t.set(encTweak);
  else t.set(new Uint8Array(encTweak));

  const numBlocks = data.length / AES_BLOCK_SIZE;
  for (let j = 0; j < numBlocks; j++) {
    const off = j * AES_BLOCK_SIZE;
    const block = out.subarray(off, off + AES_BLOCK_SIZE);
    xorBlocks(block, t, 0);
    const enc = unsafe.encryptBlock(dataKeyExp, block);
    if (enc instanceof Uint8Array) block.set(enc);
    else block.set(new Uint8Array(enc));
    xorBlocks(block, t, 0);
    gfMul(t);
  }
  return out;
}

/**
 * Decrypt a single NVS data unit (32 bytes = 2 AES blocks) using AES-256-XTS.
 */
function xtsDecryptUnit(
  dataKeyDecExp: Uint32Array,
  tweakKeyExp: Uint32Array,
  tweak: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(data.length);
  out.set(data);

  const t = new Uint8Array(AES_BLOCK_SIZE);
  t.set(tweak);
  const encTweak = unsafe.encryptBlock(tweakKeyExp, t);
  if (encTweak instanceof Uint8Array) t.set(encTweak);
  else t.set(new Uint8Array(encTweak));

  const numBlocks = data.length / AES_BLOCK_SIZE;
  for (let j = 0; j < numBlocks; j++) {
    const off = j * AES_BLOCK_SIZE;
    const block = out.subarray(off, off + AES_BLOCK_SIZE);
    xorBlocks(block, t, 0);
    const dec = unsafe.decryptBlock(dataKeyDecExp, block);
    if (dec instanceof Uint8Array) block.set(dec);
    else block.set(new Uint8Array(dec));
    xorBlocks(block, t, 0);
    gfMul(t);
  }
  return out;
}

function makeTweak(relAddr: number): Uint8Array {
  const tweak = new Uint8Array(AES_BLOCK_SIZE);
  new DataView(tweak.buffer).setUint32(0, relAddr, true);
  return tweak;
}

/**
 * Encrypt an entire NVS partition in-place. Only entries (offset >= 64 per page)
 * are encrypted; page headers and bitmaps remain plaintext.
 *
 * @param key - `eky` and `tky` must each be exactly {@link NVS_KEY_SIZE} (32) bytes.
 */
export function encryptNvsPartition(image: Uint8Array, key: NvsEncryptionKey): Uint8Array {
  assertNvsKey(key);
  const dataKeyExp = toUint32Array(unsafe.expandKeyLE(key.eky));
  const tweakKeyExp = toUint32Array(unsafe.expandKeyLE(key.tky));
  const out = new Uint8Array(image);
  const pageCount = Math.floor(out.length / PAGE_SIZE);

  for (let p = 0; p < pageCount; p++) {
    const pageBase = p * PAGE_SIZE;
    for (let e = 0; e < (PAGE_SIZE - FIRST_ENTRY_OFFSET) / ENTRY_SIZE; e++) {
      const entryOffset = pageBase + FIRST_ENTRY_OFFSET + e * ENTRY_SIZE;
      const entryData = out.subarray(entryOffset, entryOffset + ENTRY_SIZE);
      if (entryData.every((b) => b === 0xff)) continue;

      const relAddr = p * PAGE_SIZE + FIRST_ENTRY_OFFSET + e * ENTRY_SIZE;
      const tweak = makeTweak(relAddr);
      const encrypted = xtsEncryptUnit(dataKeyExp, tweakKeyExp, tweak, entryData);
      out.set(encrypted, entryOffset);
    }
  }
  return out;
}

/**
 * Decrypt an entire NVS partition. Returns a new buffer with plaintext entries.
 *
 * @param key - `eky` and `tky` must each be exactly {@link NVS_KEY_SIZE} (32) bytes.
 */
export function decryptNvsPartition(image: Uint8Array, key: NvsEncryptionKey): Uint8Array {
  assertNvsKey(key);
  const dataKeyDecExp = toUint32Array(unsafe.expandKeyDecLE(key.eky));
  const tweakKeyExp = toUint32Array(unsafe.expandKeyLE(key.tky));
  const out = new Uint8Array(image);
  const pageCount = Math.floor(out.length / PAGE_SIZE);

  for (let p = 0; p < pageCount; p++) {
    const pageBase = p * PAGE_SIZE;
    for (let e = 0; e < (PAGE_SIZE - FIRST_ENTRY_OFFSET) / ENTRY_SIZE; e++) {
      const entryOffset = pageBase + FIRST_ENTRY_OFFSET + e * ENTRY_SIZE;
      const entryData = out.subarray(entryOffset, entryOffset + ENTRY_SIZE);
      if (entryData.every((b) => b === 0xff)) continue;

      const relAddr = p * PAGE_SIZE + FIRST_ENTRY_OFFSET + e * ENTRY_SIZE;
      const tweak = makeTweak(relAddr);
      const decrypted = xtsDecryptUnit(dataKeyDecExp, tweakKeyExp, tweak, entryData);
      out.set(decrypted, entryOffset);
    }
  }
  return out;
}

function toUint32Array(v: Uint32Array | ArrayBuffer): Uint32Array {
  if (v instanceof Uint32Array) return v;
  return new Uint32Array(v);
}
