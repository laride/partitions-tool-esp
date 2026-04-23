import { crc32 } from '../common/crc32.js';
import { InputError } from '../common/errors.js';

/**
 * Wear-Leveling (WL) wrapper used by ESP-IDF's `wl_fatfsgen.py` when FAT
 * partitions are mounted behind the `esp_partition`/`wear_levelling`
 * component.
 *
 * Layout of a WL-wrapped image (all WL sector sizes are 4096 bytes):
 *
 * ```
 * [ 1 dummy sector          ]  <- WL_DUMMY_SECTORS_COUNT
 * [ plain FATFS image       ]  <- (total_sectors - wl_sectors) * 4096
 * [ 2 safe-mode dump sectors]  (only when mode == 'safe')
 * [ state copy 1            ]  <- wl_state_sectors * 4096
 * [ state copy 2            ]  <- wl_state_sectors * 4096
 * [ config sector           ]  <- WL_CFG_SECTORS_COUNT (1)
 * ```
 *
 * `wl_state_sectors = ceil((64 + 16 * total_sectors) / 4096)`.
 *
 * At mount time the WL layer reconstructs the plain FATFS by shifting sectors
 * according to the persisted `move_count` and reclaiming the dummy sector.
 * For a freshly generated image, `move_count == 0` and the first record is
 * untouched (0xFF), so unwrapping just strips the dummy sector and the
 * metadata tail.
 */

export const WL_SECTOR_SIZE = 0x1000;
export const WL_DUMMY_SECTORS_COUNT = 1;
export const WL_CFG_SECTORS_COUNT = 1;
export const WL_STATE_COPY_COUNT = 2;
export const WL_STATE_HEADER_SIZE = 64;
export const WL_STATE_RECORD_SIZE = 16;
export const WL_CONFIG_HEADER_SIZE = 48;
export const WL_SAFE_MODE_DUMP_SECTORS = 2;

/** Default `updaterate` used by ESP-IDF (FATDefaults.UPDATE_RATE). */
export const WL_DEFAULT_UPDATE_RATE = 16;
/** Default `wr_size` used by ESP-IDF (FATDefaults.WR_SIZE). */
export const WL_DEFAULT_WR_SIZE = 16;
/** Default version stored in WL state/config (FATDefaults.VERSION). */
export const WL_DEFAULT_VERSION = 2;
/** Default temporary buffer size (FATDefaults.TEMP_BUFFER_SIZE). */
export const WL_DEFAULT_TEMP_BUFF_SIZE = 32;

export type WlMode = 'perf' | 'safe';

export interface WearLevelingOptions {
  /**
   * WL operational mode. `'perf'` (default) matches the production default in
   * ESP-IDF; `'safe'` reserves two extra dump sectors for crash-safety.
   */
  mode?: WlMode;
  /**
   * 32-bit device identifier baked into the state sector. `wl_fatfsgen.py`
   * uses a random value; we default to `0` for deterministic output. Pass any
   * 32-bit unsigned value to override.
   */
  deviceId?: number;
  /** WL config/state version, written verbatim. Defaults to 2. */
  version?: number;
  /** WL temp buffer size (stored in config). Defaults to 32. */
  tempBufferSize?: number;
  /** WL update rate (stored in config). Defaults to 16. */
  updateRate?: number;
  /** WL write size (stored in config). Defaults to 16. */
  wrSize?: number;
}

export interface WlLayout {
  totalSectors: number;
  wlStateSectors: number;
  safeModeSectors: number;
  wlSectors: number;
  plainFatSectors: number;
  plainImageSize: number;
  partitionSize: number;
}

/**
 * Compute the WL layout for a given partition size and mode. Throws
 * `InputError` when the partition is too small to hold any FATFS data after
 * reserving WL metadata.
 */
export function computeWlLayout(partitionSize: number, mode: WlMode = 'perf'): WlLayout {
  if (partitionSize % WL_SECTOR_SIZE !== 0) {
    throw new InputError(
      `wear-leveling partition size ${partitionSize} must be a multiple of ${WL_SECTOR_SIZE}`,
    );
  }
  const totalSectors = partitionSize / WL_SECTOR_SIZE;
  const wlStateSize = WL_STATE_HEADER_SIZE + WL_STATE_RECORD_SIZE * totalSectors;
  const wlStateSectors = Math.ceil(wlStateSize / WL_SECTOR_SIZE);
  const safeModeSectors = mode === 'safe' ? WL_SAFE_MODE_DUMP_SECTORS : 0;
  const wlSectors =
    WL_DUMMY_SECTORS_COUNT +
    WL_CFG_SECTORS_COUNT +
    wlStateSectors * WL_STATE_COPY_COUNT +
    safeModeSectors;
  if (wlSectors >= totalSectors) {
    throw new InputError(
      `partition of ${partitionSize} bytes is too small for wear leveling (needs at least ${(wlSectors + 1) * WL_SECTOR_SIZE} bytes)`,
    );
  }
  const plainFatSectors = totalSectors - wlSectors;
  return {
    totalSectors,
    wlStateSectors,
    safeModeSectors,
    wlSectors,
    plainFatSectors,
    plainImageSize: plainFatSectors * WL_SECTOR_SIZE,
    partitionSize,
  };
}

/**
 * Wrap an already-generated plain FATFS image with WL metadata. The returned
 * image is exactly `partitionSize` bytes and is byte-for-byte compatible with
 * `wl_fatfsgen.py` when `deviceId` matches.
 *
 * The `plainImage` must be `computeWlLayout(partitionSize, mode).plainImageSize`
 * bytes long.
 */
export function wrapWearLeveling(
  plainImage: Uint8Array,
  partitionSize: number,
  opts: WearLevelingOptions = {},
): Uint8Array {
  const mode = opts.mode ?? 'perf';
  const layout = computeWlLayout(partitionSize, mode);
  if (plainImage.byteLength !== layout.plainImageSize) {
    throw new InputError(
      `plain FATFS image is ${plainImage.byteLength} bytes; expected ${layout.plainImageSize} for a ${partitionSize}-byte WL partition`,
    );
  }

  const out = new Uint8Array(partitionSize);
  out.fill(0xff);

  // 1. Dummy sector (WL_DUMMY_SECTORS_COUNT * WL_SECTOR_SIZE of 0xFF) -- already filled.
  let offset = WL_DUMMY_SECTORS_COUNT * WL_SECTOR_SIZE;

  // 2. Plain FATFS image.
  out.set(plainImage, offset);
  offset += plainImage.byteLength;

  // 3. Safe-mode dump sectors (0xFF) -- already filled.
  offset += layout.safeModeSectors * WL_SECTOR_SIZE;

  // 4. Two copies of the state sector.
  const stateSector = buildStateSector(layout, mode, opts);
  for (let copy = 0; copy < WL_STATE_COPY_COUNT; copy++) {
    out.set(stateSector, offset);
    offset += stateSector.byteLength;
  }

  // 5. Config sector.
  const configSector = buildConfigSector(partitionSize, opts);
  out.set(configSector, offset);
  offset += configSector.byteLength;

  if (offset !== partitionSize) {
    throw new Error(
      `internal WL wrap offset mismatch: wrote ${offset} bytes, expected ${partitionSize}`,
    );
  }
  return out;
}

/**
 * Strip WL metadata from an image, returning the plain FATFS image that can
 * be handed to {@link parse}. Mirrors `wl_fatfsgen.remove_wl`.
 *
 * Supports both freshly-generated images (where `move_count == 0` and the
 * dummy sector is at offset 0) and images that have been modified at runtime.
 */
export function removeWearLeveling(image: Uint8Array, mode: WlMode = 'perf'): Uint8Array {
  const layout = computeWlLayout(image.byteLength, mode);
  const wlStateTotalSize = layout.wlStateSectors * WL_SECTOR_SIZE;
  const wlTailSize = wlStateTotalSize * WL_STATE_COPY_COUNT + WL_SECTOR_SIZE;
  const wlTail = image.subarray(image.byteLength - wlTailSize);

  const stateHeader = parseStateHeader(wlTail.subarray(0, WL_STATE_HEADER_SIZE));

  // Count consumed records in the first state copy.
  let totalRecords = 0;
  for (
    let i = WL_STATE_HEADER_SIZE;
    i + WL_STATE_RECORD_SIZE <= wlStateTotalSize;
    i += WL_STATE_RECORD_SIZE
  ) {
    const chunk = wlTail.subarray(i, i + WL_STATE_RECORD_SIZE);
    if (isAllFF(chunk)) break;
    totalRecords++;
  }

  // Remove the dummy sector (which moves as records are consumed).
  const dummyOffset = totalRecords * WL_SECTOR_SIZE;
  const beforeDummy = image.subarray(0, dummyOffset);
  const afterDummy = image.subarray(dummyOffset + WL_SECTOR_SIZE);
  const withoutDummy = new Uint8Array(beforeDummy.byteLength + afterDummy.byteLength);
  withoutDummy.set(beforeDummy, 0);
  withoutDummy.set(afterDummy, beforeDummy.byteLength);

  // Drop the WL tail (state copies + config + safe dump, if any).
  const safeDumpSize = layout.safeModeSectors * WL_SECTOR_SIZE;
  const tailToDrop = wlStateTotalSize * WL_STATE_COPY_COUNT + WL_SECTOR_SIZE + safeDumpSize;
  const withoutTail = withoutDummy.subarray(0, withoutDummy.byteLength - tailToDrop);

  // Reorder sectors so that the original FATFS ordering is restored.
  const moveCount = stateHeader.moveCount;
  if (moveCount > 0) {
    const boundary = withoutTail.byteLength - moveCount * WL_SECTOR_SIZE;
    if (boundary < 0) {
      throw new InputError(`invalid WL move_count ${moveCount} for ${image.byteLength}-byte image`);
    }
    const reordered = new Uint8Array(withoutTail.byteLength);
    reordered.set(withoutTail.subarray(boundary), 0);
    reordered.set(withoutTail.subarray(0, boundary), withoutTail.byteLength - boundary);
    return reordered;
  }
  // Copy to detach from source buffer.
  return withoutTail.slice();
}

export interface WlStateHeader {
  pos: number;
  maxPos: number;
  moveCount: number;
  accessCount: number;
  maxCount: number;
  blockSize: number;
  version: number;
  deviceId: number;
  crc: number;
}

/** Parse the first 64 bytes (header + CRC) of a WL state sector. */
export function parseStateHeader(sector: Uint8Array): WlStateHeader {
  if (sector.byteLength < WL_STATE_HEADER_SIZE) {
    throw new InputError(
      `state sector needs >= ${WL_STATE_HEADER_SIZE} bytes, got ${sector.byteLength}`,
    );
  }
  const view = new DataView(sector.buffer, sector.byteOffset, WL_STATE_HEADER_SIZE);
  return {
    pos: view.getUint32(0, true),
    maxPos: view.getUint32(4, true),
    moveCount: view.getUint32(8, true),
    accessCount: view.getUint32(12, true),
    maxCount: view.getUint32(16, true),
    blockSize: view.getUint32(20, true),
    version: view.getUint32(24, true),
    deviceId: view.getUint32(28, true),
    crc: view.getUint32(60, true),
  };
}

function buildStateSector(layout: WlLayout, mode: WlMode, opts: WearLevelingOptions): Uint8Array {
  const version = opts.version ?? WL_DEFAULT_VERSION;
  const deviceId = opts.deviceId ?? 0;
  const maxPos =
    layout.plainFatSectors +
    WL_DUMMY_SECTORS_COUNT +
    (mode === 'safe' ? WL_SAFE_MODE_DUMP_SECTORS : 0);

  const sector = new Uint8Array(layout.wlStateSectors * WL_SECTOR_SIZE);
  sector.fill(0xff);

  const view = new DataView(sector.buffer, sector.byteOffset, WL_STATE_HEADER_SIZE);
  view.setUint32(0, 0, true); // pos
  view.setUint32(4, maxPos, true); // max_pos
  view.setUint32(8, 0, true); // move_count
  view.setUint32(12, 0, true); // access_count
  view.setUint32(16, WL_DEFAULT_UPDATE_RATE, true); // max_count
  view.setUint32(20, WL_SECTOR_SIZE, true); // block_size
  view.setUint32(24, version >>> 0, true); // version
  view.setUint32(28, deviceId >>> 0, true); // device_id
  // 28 bytes reserved (zero)
  for (let i = 32; i < 60; i++) sector[i] = 0;
  const crc = crc32(sector.subarray(0, 60), 0xffffffff);
  view.setUint32(60, crc, true);
  return sector;
}

function buildConfigSector(partitionSize: number, opts: WearLevelingOptions): Uint8Array {
  const version = opts.version ?? WL_DEFAULT_VERSION;
  const tempBufferSize = opts.tempBufferSize ?? WL_DEFAULT_TEMP_BUFF_SIZE;
  const updateRate = opts.updateRate ?? WL_DEFAULT_UPDATE_RATE;
  const wrSize = opts.wrSize ?? WL_DEFAULT_WR_SIZE;

  const sector = new Uint8Array(WL_SECTOR_SIZE);
  sector.fill(0xff);

  const view = new DataView(sector.buffer, sector.byteOffset, WL_CONFIG_HEADER_SIZE);
  view.setUint32(0, 0, true); // start_addr
  view.setUint32(4, partitionSize >>> 0, true); // full_mem_size
  view.setUint32(8, WL_SECTOR_SIZE, true); // page_size
  view.setUint32(12, WL_SECTOR_SIZE, true); // sector_size
  view.setUint32(16, updateRate, true); // updaterate
  view.setUint32(20, wrSize, true); // wr_size
  view.setUint32(24, version >>> 0, true); // version
  view.setUint32(28, tempBufferSize, true); // temp_buff_size
  const crc = crc32(sector.subarray(0, 32), 0xffffffff);
  view.setUint32(32, crc, true); // CRC over 32-byte struct
  view.setUint32(36, 0, true); // align padding (3x u32 zero)
  view.setUint32(40, 0, true);
  view.setUint32(44, 0, true);
  // Remaining bytes stay 0xFF.
  return sector;
}

function isAllFF(data: Uint8Array): boolean {
  for (let i = 0; i < data.byteLength; i++) {
    if (data[i] !== 0xff) return false;
  }
  return true;
}
