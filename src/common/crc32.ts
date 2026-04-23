const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * CRC32 IEEE 802.3, standard zlib/PNG variant, matching Python's `zlib.crc32`.
 * Default `seed` is 0. Returns an unsigned 32-bit value.
 */
export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/**
 * Matches Python's `zlib.crc32(data, 0xFFFFFFFF)` idiom used by ESP-IDF NVS code.
 * Equivalent to: `crc32(data, 0xFFFFFFFF)`.
 */
export function crc32Nvs(data: Uint8Array): number {
  return crc32(data, 0xffffffff);
}
