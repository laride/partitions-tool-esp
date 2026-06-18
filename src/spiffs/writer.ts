import { utf8Encode } from '../common/binary.js';
import { flattenFiles, VirtualDirectory } from '../common/virtual-fs.js';
import { buildConfig, SpiffsBuildConfig, SpiffsBuildInput } from './config.js';
import { DataPage, IndexPage, LookupPage, SpiffsFull, SpiffsPageBase } from './pages.js';

class Block {
  readonly pages: SpiffsPageBase[] = [];
  readonly luPages: LookupPage[] = [];
  readonly offset: number;
  remainingPages: number;
  private luPageIdx = 0;

  curObjId = 0;
  curObjIndexSpanIx = 0;
  curObjDataSpanIx = 0;
  curObjIdxPage: IndexPage | null = null;

  constructor(
    readonly bix: number,
    private readonly config: SpiffsBuildConfig,
  ) {
    this.offset = bix * config.blockSize;
    this.remainingPages = config.OBJ_USABLE_PAGES_PER_BLOCK;
    for (let i = 0; i < config.OBJ_LU_PAGES_PER_BLOCK; i++) {
      const lu = new LookupPage(bix, config);
      this.luPages.push(lu);
      this.pages.push(lu);
    }
  }

  private resetObj(): void {
    this.curObjIndexSpanIx = 0;
    this.curObjDataSpanIx = 0;
    this.curObjId = 0;
    this.curObjIdxPage = null;
  }

  private registerPage(page: IndexPage | DataPage): void {
    if (page instanceof DataPage) {
      if (this.curObjIdxPage === null) throw new Error('no active object');
      this.curObjIdxPage.registerPage(page);
    }
    try {
      this.luPages[this.luPageIdx]!.registerPage(page);
    } catch (e) {
      if (!(e instanceof SpiffsFull)) throw e;
      this.luPageIdx += 1;
      const next = this.luPages[this.luPageIdx];
      if (!next) {
        throw new Error(
          'invalid attempt to add page to a block when there is no more space in lookup',
          { cause: e },
        );
      }
      next.registerPage(page);
    }
    this.pages.push(page);
  }

  beginObj(objId: number, size: number, name: string, objIndexSpanIx = 0, objDataSpanIx = 0): void {
    if (this.remainingPages <= 0) throw new SpiffsFull();
    this.resetObj();
    this.curObjId = objId;
    this.curObjIndexSpanIx = objIndexSpanIx;
    this.curObjDataSpanIx = objDataSpanIx;
    const page = new IndexPage(objId, this.curObjIndexSpanIx, size, name, this.config);
    this.registerPage(page);
    this.curObjIdxPage = page;
    this.remainingPages -= 1;
    this.curObjIndexSpanIx += 1;
  }

  updateObj(contents: Uint8Array): void {
    if (this.remainingPages <= 0) throw new SpiffsFull();
    const page = new DataPage(
      this.offset + this.pages.length * this.config.pageSize,
      this.curObjId,
      this.curObjDataSpanIx,
      contents,
    );
    this.registerPage(page);
    this.curObjDataSpanIx += 1;
    this.remainingPages -= 1;
  }

  endObj(): void {
    this.resetObj();
  }

  get isFull(): boolean {
    return this.remainingPages <= 0;
  }

  toBinary(blocksLim: number): Uint8Array {
    const img = new Uint8Array(this.config.blockSize).fill(0xff);
    let off = 0;
    for (let idx = 0; idx < this.pages.length; idx++) {
      const page = this.pages[idx]!;
      if (
        this.config.useMagic &&
        idx === this.config.OBJ_LU_PAGES_PER_BLOCK - 1 &&
        page instanceof LookupPage
      ) {
        page.magicfy(this.config, blocksLim);
      }
      img.set(page.toBinary(this.config), off);
      off += this.config.pageSize;
    }
    return img;
  }
}

class SpiffsFS {
  blocks: Block[] = [];
  blocksLim: number;
  remainingBlocks: number;
  curObjId = 1;

  constructor(
    readonly imgSize: number,
    readonly config: SpiffsBuildConfig,
  ) {
    if (imgSize % config.blockSize !== 0) {
      throw new Error('image size should be a multiple of block size');
    }
    this.blocksLim = imgSize / config.blockSize;
    this.remainingBlocks = this.blocksLim;
  }

  private createBlock(): Block {
    if (this.isFull) throw new SpiffsFull('the image size has been exceeded');
    const block = new Block(this.blocks.length, this.config);
    this.blocks.push(block);
    this.remainingBlocks -= 1;
    return block;
  }

  get isFull(): boolean {
    return this.remainingBlocks <= 0;
  }

  createFile(imgPath: string, contents: Uint8Array): void {
    if (this.curObjId > this.config.MAX_OBJ_ID) {
      throw new Error(
        `object id space exhausted at file '${imgPath}' (${this.curObjId} > ${this.config.MAX_OBJ_ID})`,
      );
    }
    const nameBytes = utf8Encode(imgPath);
    if (nameBytes.includes(0x00)) {
      throw new Error(`object name '${imgPath}' contains NUL byte`);
    }
    const nameByteLen = nameBytes.length;
    if (nameByteLen >= this.config.objNameLen) {
      throw new Error(
        `object name '${imgPath}' too long (${nameByteLen} bytes >= ${this.config.objNameLen}, must leave room for null terminator)`,
      );
    }
    let offset = 0;
    let block: Block;
    try {
      block = this.blocks[this.blocks.length - 1]!;
      if (!block) throw new SpiffsFull();
      block.beginObj(this.curObjId, contents.length, imgPath);
    } catch (e) {
      if (!(e instanceof SpiffsFull) && !(e instanceof TypeError)) throw e;
      block = this.createBlock();
      block.beginObj(this.curObjId, contents.length, imgPath);
    }

    const chunkLen = this.config.OBJ_DATA_PAGE_CONTENT_LEN;
    let chunk = contents.subarray(offset, offset + chunkLen);
    while (chunk.length > 0) {
      try {
        block = this.blocks[this.blocks.length - 1]!;
        try {
          block.updateObj(chunk);
        } catch (e) {
          if (!(e instanceof SpiffsFull)) throw e;
          if (block.isFull) throw new SpiffsFull();
          block.beginObj(
            this.curObjId,
            contents.length,
            imgPath,
            block.curObjIndexSpanIx,
            block.curObjDataSpanIx,
          );
          continue;
        }
      } catch (e) {
        if (!(e instanceof SpiffsFull)) throw e;
        const prev = block!;
        block = this.createBlock();
        block.curObjId = prev.curObjId;
        block.curObjIdxPage = prev.curObjIdxPage;
        block.curObjDataSpanIx = prev.curObjDataSpanIx;
        block.curObjIndexSpanIx = prev.curObjIndexSpanIx;
        continue;
      }
      offset += chunk.length;
      chunk = contents.subarray(offset, offset + chunkLen);
    }

    block!.endObj();
    this.curObjId += 1;
  }

  toBinary(): Uint8Array {
    const out = new Uint8Array(this.imgSize).fill(0xff);
    let off = 0;
    for (const block of this.blocks) {
      out.set(block.toBinary(this.blocksLim), off);
      off += this.config.blockSize;
    }
    let bix = this.blocks.length;
    if (this.config.useMagic) {
      while (this.remainingBlocks > 0) {
        const empty = new Block(bix, this.config);
        out.set(empty.toBinary(this.blocksLim), off);
        off += this.config.blockSize;
        this.remainingBlocks -= 1;
        bix += 1;
      }
    }
    return out;
  }
}

export interface SpiffsGenerateOptions extends SpiffsBuildInput {
  imageSize: number;
  /** Root directory whose files will be written into the image. */
  source: VirtualDirectory;
}

/**
 * Generate a SPIFFS filesystem image. Mirrors ESP-IDF's
 * `components/spiffs/spiffsgen.py` layout and magic values.
 * File emission order follows the supplied VirtualDirectory child order rather
 * than Python's exact `os.walk` traversal semantics.
 */
export function generate(opts: SpiffsGenerateOptions): Uint8Array {
  const config = buildConfig(opts);
  const fs = new SpiffsFS(opts.imageSize, config);
  // Iterate in the natural order of the VirtualDirectory children list.
  // Callers who need deterministic ordering should sort beforehand.
  const files = flattenFiles(opts.source);
  for (const entry of files) {
    fs.createFile('/' + entry.path.replace(/\\/g, '/'), entry.file.content);
  }
  return fs.toBinary();
}
