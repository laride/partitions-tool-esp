import { utf8Encode } from '../common/binary.js';
import {
  log2,
  SpiffsBuildConfig,
  SPIFFS_PH_FLAG_USED_FINAL,
  SPIFFS_PH_FLAG_USED_FINAL_INDEX,
  SPIFFS_PH_IX_SIZE_LEN,
  SPIFFS_PH_IX_OBJ_TYPE_LEN,
  SPIFFS_PH_FLAG_LEN,
  SPIFFS_TYPE_FILE,
  writeUint,
} from './config.js';

export type PageKind = 'lu' | 'index' | 'data';

export interface SpiffsPageBase {
  kind: PageKind;
  toBinary(config: SpiffsBuildConfig): Uint8Array;
}

export class LookupPage implements SpiffsPageBase {
  readonly kind = 'lu' as const;
  objIdsLimit: number;
  /** Each entry is `[objId, isIndexPage]`. */
  readonly objIds: Array<{ objId: number; indexPage: boolean }> = [];

  constructor(
    readonly bix: number,
    config: SpiffsBuildConfig,
  ) {
    this.objIdsLimit = config.OBJ_LU_PAGES_OBJ_IDS_LIM;
  }

  registerPage(page: IndexPage | DataPage): void {
    if (this.objIdsLimit <= 0) throw new SpiffsFull();
    this.objIds.push({ objId: page.objId, indexPage: page instanceof IndexPage });
    this.objIdsLimit -= 1;
  }

  toBinary(config: SpiffsBuildConfig): Uint8Array {
    const out = new Uint8Array(config.pageSize).fill(0xff);
    const view = new DataView(out.buffer);
    let offset = 0;
    const msbMask = 1 << (config.objIdLen * 8 - 1);
    for (const { objId, indexPage } of this.objIds) {
      const val = indexPage ? objId ^ msbMask : objId;
      writeUint(view, offset, val >>> 0, config.objIdLen, config.endianness);
      offset += config.objIdLen;
    }
    return out;
  }

  /**
   * Called on the last lookup page in a block (when magic is enabled) to fill
   * the last two slots with a canonical magic value + one padding entry.
   */
  magicfy(config: SpiffsBuildConfig, blocksLim: number): void {
    const remaining = this.objIdsLimit;
    const emptyObjId: Record<number, number> = {
      1: 0xff,
      2: 0xffff,
      4: 0xffffffff,
      8: 0xffffffff,
    };
    if (remaining < 2) return;

    for (let i = 0; i < remaining; i++) {
      if (i === remaining - 2) {
        this.objIds.push({ objId: calcMagic(config, blocksLim, this.bix), indexPage: false });
        break;
      }
      this.objIds.push({ objId: emptyObjId[config.objIdLen]!, indexPage: false });
      this.objIdsLimit -= 1;
    }
  }
}

function calcMagic(config: SpiffsBuildConfig, blocksLim: number, bix: number): number {
  let magic = 0x20140529 ^ config.pageSize;
  if (config.useMagicLen) magic = magic ^ (blocksLim - bix);
  const mask = (2 << (8 * config.objIdLen)) - 1;
  return magic & mask;
}

export class IndexPage implements SpiffsPageBase {
  readonly kind = 'index' as const;
  readonly objId: number;
  readonly spanIx: number;
  readonly name: string;
  readonly size: number;
  pagesLim: number;
  readonly pages: number[] = [];

  constructor(
    objId: number,
    spanIx: number,
    size: number,
    name: string,
    config: SpiffsBuildConfig,
  ) {
    this.objId = objId;
    this.spanIx = spanIx;
    this.size = size;
    this.name = name;
    this.pagesLim =
      spanIx === 0 ? config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM : config.OBJ_INDEX_PAGES_OBJ_IDS_LIM;
  }

  registerPage(page: DataPage): void {
    if (this.pagesLim <= 0) throw new SpiffsFull();
    this.pages.push(page.offset);
    this.pagesLim -= 1;
  }

  toBinary(config: SpiffsBuildConfig): Uint8Array {
    const out = new Uint8Array(config.pageSize).fill(0xff);
    const view = new DataView(out.buffer);
    const msbMask = 1 << (config.objIdLen * 8 - 1);
    let offset = 0;

    writeUint(view, offset, (this.objId ^ msbMask) >>> 0, config.objIdLen, config.endianness);
    offset += config.objIdLen;
    writeUint(view, offset, this.spanIx, config.spanIxLen, config.endianness);
    offset += config.spanIxLen;
    writeUint(view, offset, SPIFFS_PH_FLAG_USED_FINAL_INDEX, SPIFFS_PH_FLAG_LEN, config.endianness);
    offset += SPIFFS_PH_FLAG_LEN;
    offset += config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED_PAD;

    if (this.spanIx === 0) {
      writeUint(view, offset, this.size, SPIFFS_PH_IX_SIZE_LEN, config.endianness);
      offset += SPIFFS_PH_IX_SIZE_LEN;
      writeUint(view, offset, SPIFFS_TYPE_FILE, SPIFFS_PH_IX_OBJ_TYPE_LEN, config.endianness);
      offset += SPIFFS_PH_IX_OBJ_TYPE_LEN;

      const nameBytes = utf8Encode(this.name);
      out.set(nameBytes, offset);
      const zeroPadLen =
        config.objNameLen -
        nameBytes.length +
        config.metaLen +
        config.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED_PAD;
      // Fill zero-bytes for the padding region. The tail pad (if aligned tables) is zero too.
      out.fill(0x00, offset + nameBytes.length, offset + nameBytes.length + zeroPadLen);
      offset += nameBytes.length + zeroPadLen;
    }

    const shift = log2(config.pageSize);
    for (const dataOffset of this.pages) {
      const pageIx = dataOffset >>> shift;
      writeUint(view, offset, pageIx, config.pageIxLen, config.endianness);
      offset += config.pageIxLen;
    }
    return out;
  }
}

export class DataPage implements SpiffsPageBase {
  readonly kind = 'data' as const;
  readonly objId: number;
  readonly spanIx: number;
  readonly contents: Uint8Array;
  readonly offset: number;

  constructor(offset: number, objId: number, spanIx: number, contents: Uint8Array) {
    this.offset = offset;
    this.objId = objId;
    this.spanIx = spanIx;
    this.contents = contents;
  }

  toBinary(config: SpiffsBuildConfig): Uint8Array {
    const out = new Uint8Array(config.pageSize).fill(0xff);
    const view = new DataView(out.buffer);
    let offset = 0;
    writeUint(view, offset, this.objId >>> 0, config.objIdLen, config.endianness);
    offset += config.objIdLen;
    writeUint(view, offset, this.spanIx, config.spanIxLen, config.endianness);
    offset += config.spanIxLen;
    writeUint(view, offset, SPIFFS_PH_FLAG_USED_FINAL, SPIFFS_PH_FLAG_LEN, config.endianness);
    offset += SPIFFS_PH_FLAG_LEN;
    out.set(this.contents, offset);
    return out;
  }
}

export class SpiffsFull extends Error {
  constructor(msg = 'spiffs full') {
    super(msg);
  }
}
