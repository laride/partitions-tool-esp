import { createDir, createFile, VirtualDirectory } from '../common/virtual-fs.js';
import { trimNull, utf8Decode } from '../common/binary.js';
import {
  buildConfig,
  readUint,
  SpiffsBuildConfig,
  SpiffsBuildInput,
  SPIFFS_PH_FLAG_LEN,
  SPIFFS_PH_FLAG_USED_FINAL,
  SPIFFS_PH_FLAG_USED_FINAL_INDEX,
  SPIFFS_PH_IX_OBJ_TYPE_LEN,
  SPIFFS_PH_IX_SIZE_LEN,
} from './config.js';

export interface SpiffsParsedFile {
  path: string;
  size: number;
  /** Reassembled file contents from data pages. */
  content: Uint8Array;
}

export interface SpiffsParseResult {
  config: SpiffsBuildConfig;
  files: SpiffsParsedFile[];
  /** Convenience root directory tree. */
  root: VirtualDirectory;
}

export interface SpiffsParseOptions extends SpiffsBuildInput {
  imageSize?: number;
}

/**
 * Parse a SPIFFS image. Supports the default configuration produced by
 * `spiffsgen.py` and is designed to be compatible with
 * `components/spiffs/spiffs_nucleus.h` v0.3.7.
 */
export function parse(image: Uint8Array, opts: SpiffsParseOptions = {}): SpiffsParseResult {
  const config = buildConfig(opts);
  if (image.length % config.blockSize !== 0) {
    throw new Error(
      `SPIFFS image length ${image.length} is not a multiple of block size ${config.blockSize}`,
    );
  }

  const msbMask = 1 << (config.objIdLen * 8 - 1);

  interface PageHeader {
    objId: number;
    spanIx: number;
    flags: number;
    absoluteOffset: number;
  }

  const indexPages = new Map<number, Map<number, PageHeader>>(); // objId -> spanIx -> header
  const dataPages = new Map<number, Map<number, PageHeader>>(); // objId -> spanIx -> header

  for (let bix = 0; bix < image.length / config.blockSize; bix++) {
    const blockOffset = bix * config.blockSize;
    for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
      const off = blockOffset + pix * config.pageSize;
      const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
      const objIdRaw = Number(readUint(view, 0, config.objIdLen, config.endianness));
      const spanIx = Number(readUint(view, config.objIdLen, config.spanIxLen, config.endianness));
      const flags = Number(
        readUint(view, config.objIdLen + config.spanIxLen, SPIFFS_PH_FLAG_LEN, config.endianness),
      );

      // Empty slots in a formatted SPIFFS have objId = 0xFFFF.
      if (objIdRaw === 0 || objIdRaw === (1 << (config.objIdLen * 8)) - 1) continue;

      const isIndex = (objIdRaw & msbMask) !== 0;
      const objId = objIdRaw & ~msbMask;

      const header: PageHeader = { objId, spanIx, flags, absoluteOffset: off };
      if (isIndex) {
        if (flags !== SPIFFS_PH_FLAG_USED_FINAL_INDEX) continue;
        addPage(indexPages, objId, spanIx, header);
      } else {
        if (flags !== SPIFFS_PH_FLAG_USED_FINAL) continue;
        addPage(dataPages, objId, spanIx, header);
      }
    }
  }

  const files: SpiffsParsedFile[] = [];

  for (const [objId, spans] of indexPages) {
    const headerEntry = spans.get(0);
    if (!headerEntry) continue;

    // Read file name and size from the first index page.
    const headView = new DataView(
      image.buffer,
      image.byteOffset + headerEntry.absoluteOffset,
      config.pageSize,
    );
    let cursor = config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED;
    const size = Number(readUint(headView, cursor, SPIFFS_PH_IX_SIZE_LEN, config.endianness));
    cursor += SPIFFS_PH_IX_SIZE_LEN + SPIFFS_PH_IX_OBJ_TYPE_LEN;
    const nameBytes = image.subarray(
      headerEntry.absoluteOffset + cursor,
      headerEntry.absoluteOffset + cursor + config.objNameLen,
    );
    const path = trimNull(utf8Decode(nameBytes));

    // Collect data pages in order; rely on data page's own span index.
    const dataSpans = dataPages.get(objId);
    if (!dataSpans) continue;
    const content = new Uint8Array(size);
    let written = 0;
    const sortedSpans = [...dataSpans.keys()].sort((a, b) => a - b);
    for (const ix of sortedSpans) {
      const page = dataSpans.get(ix)!;
      const remaining = size - written;
      if (remaining <= 0) break;
      const chunkLen = Math.min(config.OBJ_DATA_PAGE_CONTENT_LEN, remaining);
      const off = page.absoluteOffset + config.OBJ_DATA_PAGE_HEADER_LEN;
      content.set(image.subarray(off, off + chunkLen), written);
      written += chunkLen;
    }
    files.push({ path, size, content });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const root = buildTree(files);
  return { config, files, root };
}

function addPage<T>(
  store: Map<number, Map<number, T>>,
  objId: number,
  spanIx: number,
  value: T,
): void {
  let bucket = store.get(objId);
  if (!bucket) {
    bucket = new Map();
    store.set(objId, bucket);
  }
  bucket.set(spanIx, value);
}

function buildTree(files: SpiffsParsedFile[]): VirtualDirectory {
  const root = createDir('/');
  for (const file of files) {
    const parts = file.path.replace(/^\/+/, '').split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let child = dir.children.find((c) => c.kind === 'dir' && c.name === name) as
        | VirtualDirectory
        | undefined;
      if (!child) {
        child = createDir(name);
        dir.children.push(child);
      }
      dir = child;
    }
    const leaf = parts[parts.length - 1]!;
    dir.children.push(createFile(leaf, file.content));
  }
  return root;
}
