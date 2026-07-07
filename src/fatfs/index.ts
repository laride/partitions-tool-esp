export { generate, fatfsAreaSize, type FatfsGenerateOptions } from './writer.js';
export {
  parse,
  flatten,
  type FatfsBootSector,
  type FatfsParseResult,
  type FatfsParseOptions,
} from './parser.js';
export {
  wrapWearLeveling,
  removeWearLeveling,
  computeWlLayout,
  parseStateHeader,
  type WearLevelingOptions,
  type WlLayout,
  type WlMode,
  type WlStateHeader,
  WL_SECTOR_SIZE,
  WL_FAT_SECTOR_SIZE_512,
  WL_FAT_SECTOR_SIZE_4096,
  WL_DUMMY_SECTORS_COUNT,
  WL_CFG_SECTORS_COUNT,
  WL_STATE_COPY_COUNT,
  WL_STATE_HEADER_SIZE,
  WL_STATE_RECORD_SIZE,
  WL_CONFIG_HEADER_SIZE,
  WL_SAFE_MODE_DUMP_SECTORS,
} from './wear-leveling.js';
