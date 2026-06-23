# partitions-tool-esp

[中文](./README_CN.md)

<div align="center">
  <a href ="https://www.npmjs.com/package/partitions-tool-esp" target="_blank">
    <img alt="NPM Version" src="https://img.shields.io/npm/v/partitions-tool-esp" />
  </a>
  <a href="https://github.com/laride/partitions-tool-esp" target="_blank">
    <img alt="GitHub Repo" src="https://img.shields.io/badge/github-repo-blue?logo=github" />
  </a>
</div>

A pure JavaScript / TypeScript implementation for generating and parsing ESP-IDF partition tables and their common partition contents.

Currently supports generation and parsing of the following partition formats:

- Partition Table `partition_table`
- NVS `nvs`
  - Plain-text NVS v1 / v2
  - Encrypted NVS (AES-256-XTS)
  - multipage blob
- FAT `data.fat`
  - FAT12 / FAT16 / FAT32
  - SFN(8.3) or LFN
  - Wear leveling
- SPIFFS `data.spiffs`

## Installation

```bash
pnpm add partitions-tool-esp # or use your preferred package manager
```

## Quick Start

> [!TIP]
>
> When the partition size of NVS, SPIFFS, or FATFS cannot accommodate the provided files, the related functions will throw an error.
> Parser functions for NVS, SPIFFS, FATFS, and LittleFS also support best-effort diagnostics via `warnings` in the parse result and an optional `onWarning` callback.

### Partition Table

The partition table supports mutual conversion between CSV format files and `partitions.bin`.

```ts
// PartitionTable is a class; import it from the subpath export.
import { PartitionTable } from 'partitions-tool-esp/partition-table';

const csv = `# Name, Type, SubType, Offset, Size, Flags
nvs,      data, nvs,     ,        0x6000,
phy_init, data, phy,     ,        0x1000,
factory,  app,  factory, ,        1M,
`;

const table = PartitionTable.fromCSV(csv, { flashSize: 4 * 1024 * 1024 });
const bin = table.toBinary(); // Uint8Array, suitable for writing to partitions.bin

const roundtrip = PartitionTable.fromBinary(bin);
console.log(roundtrip.entries[0].name); // "nvs"
console.log(roundtrip.toCSV()); // restore CSV
```

The Partition Table generation logic is implemented based on [`gen_esp32part.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/partition_table/gen_esp32part.py#).

### NVS

NVS partitions support three equivalent construction methods:

```ts
import { NVS } from 'partitions-tool-esp';

// 1) Using ESP-IDF `nvs_partition_gen.py` tool-style CSV
const csvBin = NVS.generate(
  NVS.parseCSV(`key,type,encoding,value
storage,namespace,,
greeting,data,string,hello world
counter,data,u32,42
ratio,data,float,1.5
precise,data,double,3.141592653589793
`),
  { size: 0x6000 },
);

// 2) Chained Builder
const builderBin = NVS.generate(
  new NVS.NvsBuilder()
    .namespace('storage')
    .string('greeting', 'hello world')
    .u32('counter', 42)
    .float('ratio', 1.5)
    .double('precise', Math.PI)
    .binary('blob', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    .namespace('settings')
    .u8('flag', 1)
    .build(),
  { size: 0x6000 },
);

// 3) Structured object: namespace -> { key: value }
const objectBin = NVS.generate(
  NVS.fromObject({
    storage: {
      greeting: 'hello world',
      counter: 42, // inferred as u32
      signed: -1, // inferred as i32
      blob: new Uint8Array([0xde, 0xad]), // inferred as binary
      flag: { type: 'u8', value: 1 }, // explicit width
      ratio: { type: 'float', value: 1.5 },
      precise: { type: 'double', value: Math.PI },
      hex: { type: 'binary', value: 'deadbeef', encoding: 'hex2bin' },
    },
    settings: {
      bigCounter: 1n << 40n, // inferred as u64
    },
  }),
  { size: 0x6000 },
);

// Reverse parsing
const dump = NVS.parse(builderBin);
for (const page of dump.pages) {
  for (const entry of page.entries) {
    if (entry.state === 'Written') console.log(entry);
  }
}

// --- Encrypted NVS ---
// Generate a random encryption key
const key = NVS.generateNvsKey();

// Generate an encrypted NVS partition
const encryptedBin = NVS.generate(
  NVS.parseCSV(`key,type,encoding,value
storage,namespace,,
secret,data,string,top-secret-value
`),
  { size: 0x6000, encryptionKey: key },
);

// Serialize the key to NVS keys partition format (for flashing)
const keysBin = NVS.serializeNvsKeyPartition(key);

// Parse an encrypted partition (decrypts transparently)
const decryptedDump = NVS.parse(encryptedBin, { decryptionKey: key });

// Standalone encrypt/decrypt for existing images
const encrypted = NVS.encryptNvsPartition(csvBin, key);
const decrypted = NVS.decryptNvsPartition(encrypted, key);

// Derive key from HMAC (matches IDF's HMAC-based key protection scheme)
const hmacKey = new Uint8Array(32); // your eFuse HMAC key
const derivedKey = NVS.deriveNvsKeyFromHmac(hmacKey);
```

In structured object mode, when a type is not explicitly specified, the library will automatically attempt to infer the data type. You can also specify it manually.

| JS Type                                 | NVS Encoding                                       |
| --------------------------------------- | -------------------------------------------------- |
| `number` (non-negative integer)         | `u32`                                              |
| `number` (negative integer)             | `i32`                                              |
| `bigint` (non-negative)                 | `u64`                                              |
| `bigint` (negative)                     | `i64`                                              |
| `string`                                | `string`                                           |
| `Uint8Array`                            | `binary` (raw)                                     |
| `{ type: 'u8'\|'i8'\|...'i64', value }` | explicit integer type                              |
| `{ type: 'float'\|'double', value }`    | explicit IEEE-754 floating-point type              |
| `{ type: 'string', value }`             | explicit string                                    |
| `{ type: 'binary', value, encoding? }`  | `encoding` can be `'raw' \| 'hex2bin' \| 'base64'` |

NVS encryption notes:

- Encryption uses **AES-256-XTS** (IEEE P1619), identical to ESP-IDF's NVS encryption scheme. Only entry data (offset >= 64 per page) is encrypted; page headers and entry-state bitmaps remain in plaintext.
- The NVS keys partition format is a 4096-byte page: 32-byte `eky` + 32-byte `tky` + 4-byte CRC32 + 0xFF padding.
- `deriveNvsKeyFromHmac()` matches the IDF HMAC-based key protection scheme (`CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC`).
- Encrypted NVS partitions should **not** be marked with the flash encryption `encrypted` flag in the partition table; NVS encryption is a software-level XTS layer independent of hardware flash encryption.

NVS compatibility notes:

- CSV input also accepts `float` / `double` encodings to cover numeric types supported by the NVS runtime. **This differs from the IDF implementation**: ESP-IDF's Python `nvs_partition_tool` does not yet support `float` / `double` encodings.
- Integer encodings are range-checked before writing. Values outside the target type width will throw `InputError`.
- For integer encodings larger than JavaScript's safe integer range, pass a `bigint` or string literal such as `'0xffffffffffffffff'` instead of a `number`.
- Static multipage blob generation always writes `chunkStart = 0`. This is valid for IDF to read, but it does not emulate the IDF runtime behavior of alternating between versioned chunk ranges (`0x00` / `0x80`) when updating blobs.
- `NVS.parse()` parses partition contents to the best of its ability; partitions that would error in the IDF C/C++ implementation can still be decoded by this tool (with warnings).
- `NVS.generate(..., { size })` defaults to version 2 (page header `0xFE`, multipage blobs). Use version 2 for all new projects. Pass `{ version: 1 }` only when you must produce legacy V1 images.
- For NVS version 1, single-page `blob` entries are limited to 1984 bytes. **This differs within the IDF toolchain**: the IDF C++ runtime allows up to 4000 bytes per single-page write, while the companion `esp_idf_nvs_partition_gen` enforces a 1984-byte limit.
- `blob_fill(N;0xXX)` and `blob_sz_fill(N;0xXX)` CSV encodings from `esp_idf_nvs_partition_gen` are **not supported**. Build the padded blob bytes yourself (e.g. with `NvsBuilder.binary()` or `{ type: 'binary', value: new Uint8Array(...) }`).
- WiFi provisioning side effects in `esp_idf_nvs_partition_gen` are **not supported**: writing `sta.ssid` / `sta.pswd` does not auto-add `sta.apinfo`, `sta.pmk`, or `sta.apsw`, and `ap.ssid` / `ap.passwd` / `ap.authmode` do not auto-compute `ap.pmk_info`. Add those keys explicitly if your workflow needs them.

The NVS tool is implemented with reference to [ESP-IDF's NVS implementation](https://github.com/espressif/esp-idf/blob/fb14a3e7f45b93cc59e6efaf651013c560ef3549/components/nvs_flash/) (C/C++ and Python implementations).

### SPIFFS

```ts
import { SPIFFS, createDir, createFile } from 'partitions-tool-esp';

const image = SPIFFS.generate({
  imageSize: 0x10000,
  pageSize: 256,
  objNameLen: 32,
  metaLen: 4,
  useMagic: true,
  useMagicLength: true,
  source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello\n'))]),
});

const parsed = SPIFFS.parse(image, { pageSize: 256, objNameLen: 32, metaLen: 4 });
for (const f of parsed.files) {
  console.log(f.path, new TextDecoder().decode(f.content));
}
```

The SPIFFS functionality is implemented based on [`spiffsgen.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/spiffs/spiffsgen.py).

### FatFS

Supports generation and parsing of FAT12 / FAT16 / FAT32, with optional wear leveling support.

```ts
import { FatFS, createDir, createFile } from 'partitions-tool-esp';

const image = FatFS.generate({
  size: 512 * 1024,
  source: createDir('', [
    createFile('HELLO.TXT', new TextEncoder().encode('hello\n')),
    // LFN (long filename) support is enabled by default, so you can use it directly
    createFile('Hello Long Name.txt', new TextEncoder().encode('long\n')),
    createDir('SUB', [createFile('INNER.TXT', new Uint8Array([1, 2, 3]))]),
  ]),
  // volumeUuid: 0x12345678, // Volume UUID: optional, auto-assigned if omitted; specify for deterministic output
  // explicitFatType: 32,    // FAT Type: defaults to auto-select 12/16 by cluster count; pass 32 to force FAT32
  // longFilenames: false,   // Long filename support: only 8.3 filenames supported when LFN is disabled
  // espIdfCompat: false,    // IDF style preference: defaults to true
});

const parsed = FatFS.parse(image);
for (const { path, content } of FatFS.flatten(parsed.root)) {
  console.log(path, content.byteLength);
}
```

Parameter description:

- `longFilenames` LFN (long filename) support, enabled by default. When disabled, only [8.3 filenames](https://en.wikipedia.org/wiki/8.3_filename) are supported, and an error is thrown when encountering overly long filenames.
- `espIdfCompat` IDF style preference, enabled by default. The IDF built-in [`fatfsgen.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/fatfs/fatfsgen.py) has some preferences when generating FAT images, including UTF-16 lowercase byte conversion, `-N` short aliases, etc. Setting `espIdfCompat` to `true` produces output similar to IDF's `fatfsgen.py`, while setting it to `false` produces output preferred by `fsck.fat`.

To use with the `wear_levelling` component (i.e., enabling wear leveling), enable the `wearLeveling` option. The generated FATFS image will automatically reserve 1 dummy sector + 2 state sectors + 1 config sector (safe mode adds 2 more dump sectors), consistent with [`wl_fatfsgen.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/fatfs/wl_fatfsgen.py):

```ts
import { FatFS, createDir, createFile } from 'partitions-tool-esp';

const image = FatFS.generate({
  size: 1024 * 1024,
  sectorSize: FatFS.WL_SECTOR_SIZE, // WL requires 4096
  source: createDir('', [createFile('HELLO.TXT', new TextEncoder().encode('hi\n'))]),
  wearLeveling: true, // or { mode: 'safe', deviceId: 0xdeadbeef }
});

// When parsing, declare wearLeveling: true, and the library will strip WL metadata before parsing.
const parsed = FatFS.parse(image, { wearLeveling: true });

// You can also manually unwrap / wrap:
const plain = FatFS.removeWearLeveling(image);
const wrapped = FatFS.wrapWearLeveling(plain, image.byteLength, { mode: 'perf' });
```

### LittleFS

```ts
import { LittleFS, createDir, createFile } from 'partitions-tool-esp';

const image = LittleFS.generate({
  imageSize: 0x10000,
  source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello\n'))]),
});

const parsed = LittleFS.parse(image, {
  onWarning(warning) {
    console.warn(warning.message);
  },
});

console.log(parsed.files[0]?.path);
console.log(parsed.warnings);
```

`LittleFS.parse()` still throws on structural corruption that may produce inconsistent results. For best-effort decoding of suspicious-but-skippable entries such as invalid filename bytes or unsupported file types, structured warnings are collected in `parsed.warnings` and forwarded to `onWarning` when provided.

### IO Utility Helpers

This project provides some Node.js / browser I/O utility helpers.

```ts
// Node.js
import { readDir, writeDir } from 'partitions-tool-esp/io/node';
const tree = await readDir('./assets');
await writeDir(tree, './out');

// Browser
import { fromFileList, fromDirectoryHandle } from 'partitions-tool-esp/io/browser';
const dir1 = await fromFileList(inputElement.files!);
const dir2 = await fromDirectoryHandle(await showDirectoryPicker());
```

## Package Exports

| Entry                                 | Purpose                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `partitions-tool-esp`                 | Aggregate export, equivalent to `import * as PartitionTable from '.../partition-table'` etc. |
| `partitions-tool-esp/partition-table` | Partition table only                                                                         |
| `partitions-tool-esp/nvs`             | NVS only                                                                                     |
| `partitions-tool-esp/spiffs`          | SPIFFS only                                                                                  |
| `partitions-tool-esp/fatfs`           | FatFS only                                                                                   |
| `partitions-tool-esp/littlefs`        | LittleFS only                                                                                |
| `partitions-tool-esp/io/node`         | Node.js filesystem bridge                                                                    |
| `partitions-tool-esp/io/browser`      | Browser FileList / File System Access API bridge                                             |

## Development

```bash
pnpm install
pnpm prepare # Initialize husky pre-commit hook
pnpm format
pnpm lint
pnpm typecheck
pnpm test # run tests, including byte-level comparison tests against ESP-IDF built-in scripts
pnpm build
```

### Regenerating Fixtures

The comparison files in `tests/fixtures/` come from official ESP-IDF Python tools. When upstream formats change or new cases are needed:

```bash
# Enable ESP-IDF environment
source $IDF_PATH/export.sh

# Run the script (IDF_PATH environment variable should be available)
pnpm fixtures
# or
IDF_PATH=/path/to/esp-idf OUT=tests/fixtures bash scripts/build-fixtures.sh
```

`scripts/build-fixtures.sh` will invoke:

- `components/partition_table/gen_esp32part.py`
- `components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py`
- `components/spiffs/spiffsgen.py`
- `components/fatfs/fatfsgen.py`

and write the results back to `tests/fixtures/`.

> The `BS_VolID` (4 bytes at offset 39) in the FatFS image is randomly generated by `fatfsgen.py`; test cases first read this value from the test sample and pass it as `volumeUuid` to `FatFS.generate`, achieving byte-level consistency.

## Current Limitations and Roadmap

- FatFS: Supports FAT12 / FAT16 / FAT32, long filenames (LFN), wear leveling (`perf` / `safe`).
  ESP-IDF itself only supports 4096B sectors for WL (the 512 sector_size WL path is a Python-side special case), and this library similarly requires `sectorSize === 4096`.
- NVS: Encryption is supported (AES-256-XTS). Version detection patches are not yet implemented.

## License

Apache-2.0
