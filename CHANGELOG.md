# Changelog

## [0.2.0] - 2026-07-07

This version includes minor API adjustments and is not backward compatible with previous versions.

### Added

- **LittleFS** (`partitions-tool-esp/littlefs`): generate and parse `data.littlefs` partition images, with `createDir` / `createFile` source trees, configurable block/read/prog sizes, and best-effort parsing with structured warnings.
- **NVS encryption** (AES-256-XTS): `generateNvsKey`, `deriveNvsKeyFromHmac`, `serializeNvsKeyPartition`, `parseNvsKeyPartition`, `encryptNvsPartition`, `decryptNvsPartition`; transparent decrypt in `NVS.parse()` via `decryptionKey`, and encrypted generation via `encryptionKey`.
- **NVS builder API**: `NvsBuilder`, `fromObject`, and `parseCSV` for three equivalent ways to construct NVS partitions.
- **NVS types**: `float` / `double` CSV encodings and builder methods; `hex2bin` / `base64` binary encodings in structured object mode; integer range validation before write; `bigint` and string literals for values beyond JS safe integer range.
- **NVS parsing**: best-effort decode of `CORRUPTED` / `EMPTY` pages and damaged partitions; `warnings` array and optional `onWarning` callback on parse results.
- **FatFS FAT32**: generation and parsing beyond ESP-IDF's FAT12/FAT16-only Python tools.
- **FatFS LFN**: long filename support (enabled by default); `longFilenames: false` for strict 8.3 mode.
- **FatFS wear leveling**: `wearLeveling` option with `perf` / `safe` modes; `wrapWearLeveling()` / `removeWearLeveling()` utilities; support for both 4096-byte and 512-byte FAT sectors.
- **FatFS `espIdfCompat`**: opt-in IDF `fatfsgen.py` behavior (default `true`), including LFN short-alias and `DIR_NTRes` handling.
- **Partition table**: `extraSubtypes` for custom subtype names; ESP-IDF special CSV rows (`bootloader,primary`, `bootloader,recovery`, `partition_table,primary`); `secure: 'v1' | 'v2' | 'none'` app-partition validation; `fromBinary()` warnings for duplicate MD5 rows and all-`0xFF` end markers.
- **Diagnostics**: shared `ParseWarning` / `onWarning` infrastructure across partition-table, NVS, SPIFFS, FatFS, and LittleFS parsers.
- **Demo**: LittleFS page, shared `WarningsPanel`, and pnpm workspace linking to the local package.

### Changed

- **NVS `generate()`** now defaults to version 2 (page header `0xFE`, multipage blobs). Pass `{ version: 1 }` for legacy V1 images.
- **Partition table `flashSize`** is now optional; omit it to skip flash-capacity checks (previously defaulted to 4 MiB).

### Fixed

- **SPIFFS parser**: numerous correctness fixes for page/object traversal, name handling, and edge-case images.
- **FatFS wear leveling**: `removeWearLeveling()` correctly strips all WL metadata including safe-mode dump sectors (fixes IDF `wl_fatfsgen.py remove_wl()` tail-size bug).
- **FatFS LFN / FAT type selection**: aligned with FatFs C implementation; `espIdfCompat` replicates IDF Python generator quirks where needed.
- **Partition table**: stricter validation for overlapping partitions, readonly flags on `otadata` / `coredump`, and bootloader offset constraints.

## [0.1.2] - 2026-06-16

### Changed

- Upgraded `@noble/hashes` to `2.2.0` in both the main package and the demo.
- Updated the MD5 import to `@noble/hashes/legacy.js` for compatibility with the new package exports.
- Raised the main package Node.js engine requirement to `>=20.19.0` to match the upstream dependency requirement.

## [0.1.1] - 2026-06-15

First usable release.

Due to a CI issue, `0.1.0` was not published correctly to `npmjs.com`, so `0.1.1` became the first available release.

[0.2.0]: https://github.com/laride/partitions-tool-esp/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/laride/partitions-tool-esp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/laride/partitions-tool-esp/releases/tag/v0.1.1
