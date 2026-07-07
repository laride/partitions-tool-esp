import { createDir, createFile, VirtualDirectory } from '../common/virtual-fs.js';
import {
  createWarningSink,
  emitWarning,
  formatWarning,
  type ParseWarning,
  type WarningOptions,
  type WarningResult,
} from '../common/diagnostics.js';
import {
  buildConfig,
  log2,
  readUint,
  SpiffsBuildConfig,
  SpiffsBuildInput,
  SPIFFS_PH_FLAG_LEN,
  SPIFFS_PH_FLAG_USED_FINAL,
  SPIFFS_PH_FLAG_USED_FINAL_INDEX,
  SPIFFS_PH_IX_OBJ_TYPE_LEN,
  SPIFFS_PH_IX_SIZE_LEN,
  SPIFFS_TYPE_FILE,
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
  warnings: ParseWarning[];
}

export interface SpiffsParseOptions extends SpiffsBuildInput, WarningOptions {
  imageSize?: number;
}

/**
 * Parse a SPIFFS image. Supports the default configuration produced by
 * `spiffsgen.py` and is designed to be compatible with
 * `components/spiffs/spiffs_nucleus.h` v0.3.7.
 *
 * Data pages are located via the page pointer table stored in object index
 * pages (the authoritative mapping), not via data pages' self-reported spanIx.
 */
export function parse(image: Uint8Array, opts: SpiffsParseOptions = {}): SpiffsParseResult {
  const warningSink = createWarningSink(opts.onWarning);
  const config = buildConfig(opts);
  if (image.length % config.blockSize !== 0) {
    throw new Error(
      `SPIFFS image length ${image.length} is not a multiple of block size ${config.blockSize}`,
    );
  }

  const msbMask = 1 << (config.objIdLen * 8 - 1);
  const pageShift = log2(config.pageSize);
  const totalPages = image.length >>> pageShift;

  interface PageHeader {
    objId: number;
    spanIx: number;
    flags: number;
    absoluteOffset: number;
  }

  const indexPages = new Map<number, Map<number, PageHeader>>(); // objId -> spanIx -> header
  const liveLookupEntries = new Map<number, number>(); // pageIx -> raw lookup obj id

  for (let bix = 0; bix < image.length / config.blockSize; bix++) {
    const blockOffset = bix * config.blockSize;
    for (let luPix = 0; luPix < config.OBJ_LU_PAGES_PER_BLOCK; luPix++) {
      const luOff = blockOffset + luPix * config.pageSize;
      const luView = new DataView(image.buffer, image.byteOffset + luOff, config.pageSize);
      for (let entryInPage = 0; entryInPage < config.OBJ_LU_PAGES_OBJ_IDS_LIM; entryInPage++) {
        const entry = luPix * config.OBJ_LU_PAGES_OBJ_IDS_LIM + entryInPage;
        if (entry >= config.OBJ_USABLE_PAGES_PER_BLOCK) break;

        const pageIx = bix * config.PAGES_PER_BLOCK + config.OBJ_LU_PAGES_PER_BLOCK + entry;
        const objIdRaw = Number(
          readUint(luView, entryInPage * config.objIdLen, config.objIdLen, config.endianness),
        );
        if (objIdRaw === 0 || objIdRaw === (1 << (config.objIdLen * 8)) - 1) continue;
        liveLookupEntries.set(pageIx, objIdRaw);
      }
    }

    for (let pix = config.OBJ_LU_PAGES_PER_BLOCK; pix < config.PAGES_PER_BLOCK; pix++) {
      const off = blockOffset + pix * config.pageSize;
      const view = new DataView(image.buffer, image.byteOffset + off, config.pageSize);
      const objIdRaw = Number(readUint(view, 0, config.objIdLen, config.endianness));
      const spanIx = Number(readUint(view, config.objIdLen, config.spanIxLen, config.endianness));
      const flags = Number(
        readUint(view, config.objIdLen + config.spanIxLen, SPIFFS_PH_FLAG_LEN, config.endianness),
      );

      if (objIdRaw === 0 || objIdRaw === (1 << (config.objIdLen * 8)) - 1) continue;

      const pageIx = off >>> pageShift;
      const liveObjIdRaw = liveLookupEntries.get(pageIx);
      if (liveObjIdRaw !== objIdRaw) continue;

      const isIndex = (objIdRaw & msbMask) !== 0;
      const objId = objIdRaw & ~msbMask;

      if (isIndex && flags === SPIFFS_PH_FLAG_USED_FINAL_INDEX) {
        const header: PageHeader = { objId, spanIx, flags, absoluteOffset: off };
        addIndexPage(indexPages, objId, spanIx, header, warningSink);
      }
    }
  }

  const files: SpiffsParsedFile[] = [];

  for (const [objId, spans] of indexPages) {
    const headerEntry = spans.get(0);
    if (!headerEntry) {
      emitWarning(
        warningSink,
        formatWarning('SPIFFS', `object ${objId}`, 'skipped because span 0 index page is missing'),
      );
      continue;
    }

    const headView = new DataView(
      image.buffer,
      image.byteOffset + headerEntry.absoluteOffset,
      config.pageSize,
    );
    let cursor = config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED;
    const size = Number(readUint(headView, cursor, SPIFFS_PH_IX_SIZE_LEN, config.endianness));
    cursor += SPIFFS_PH_IX_SIZE_LEN;
    const objType = Number(
      readUint(headView, cursor, SPIFFS_PH_IX_OBJ_TYPE_LEN, config.endianness),
    );
    cursor += SPIFFS_PH_IX_OBJ_TYPE_LEN;

    const nameBytes = image.subarray(
      headerEntry.absoluteOffset + cursor,
      headerEntry.absoluteOffset + cursor + config.objNameLen,
    );
    const path = decodeFileName(nameBytes, warningSink, objId);

    if (objType !== SPIFFS_TYPE_FILE) {
      emitWarning(
        warningSink,
        formatWarning(
          'SPIFFS',
          `file '${path}'`,
          `object index header reports unexpected type ${objType}, continuing as file`,
        ),
      );
    }

    const maxAddressablePages = pageCapacityForIndexSpans(spans, config);
    const maxAddressableSize = maxAddressablePages * config.OBJ_DATA_PAGE_CONTENT_LEN;
    const maxImageSize = imageMaxFileSize(totalPages, config);
    const maxPossibleSize = Math.min(maxAddressableSize, maxImageSize);
    if (size > maxPossibleSize) {
      throw new Error(
        `SPIFFS file '${path}' declares impossible size ${size} bytes; ` +
          `at most ${maxPossibleSize} bytes are addressable in this image/config`,
      );
    }

    if (size === 0) {
      files.push({ path, size: 0, content: new Uint8Array(0) });
      continue;
    }

    // Collect page indices from all index pages for this object.
    // The index page table is the authoritative source for data page locations.
    const pageIndices = collectPageIndices(spans, config, image, warningSink, path);

    const neededPages = Math.ceil(size / config.OBJ_DATA_PAGE_CONTENT_LEN);
    assertFirstDataPageLooksSane(path, pageIndices, neededPages, totalPages, config.pageIxLen);
    const content = new Uint8Array(size);
    let written = 0;

    for (let spanIx = 0; spanIx < neededPages; spanIx++) {
      const remaining = size - written;
      if (remaining <= 0) break;
      const chunkLen = Math.min(config.OBJ_DATA_PAGE_CONTENT_LEN, remaining);

      if (spanIx >= pageIndices.length) {
        emitWarning(
          warningSink,
          formatWarning(
            'SPIFFS',
            `file '${path}'`,
            `index table has only ${pageIndices.length} entries but need ${neededPages} for ${size} bytes`,
          ),
        );
        break;
      }

      const pageIx = pageIndices[spanIx]!;
      const freeMarker = (1 << (config.pageIxLen * 8)) - 1;
      if (pageIx === freeMarker) {
        emitWarning(
          warningSink,
          formatWarning(
            'SPIFFS',
            `file '${path}'`,
            `index table entry at span ${spanIx} is unset (0x${freeMarker.toString(16)}), content gap filled with zeros`,
          ),
        );
        written += chunkLen;
        continue;
      }

      if (pageIx >= totalPages) {
        emitWarning(
          warningSink,
          formatWarning(
            'SPIFFS',
            `file '${path}'`,
            `index table entry at span ${spanIx} references out-of-range page ${pageIx} (total ${totalPages})`,
          ),
        );
        written += chunkLen;
        continue;
      }

      const lookupObjIdRaw = liveLookupEntries.get(pageIx);
      if (lookupObjIdRaw !== objId) {
        emitWarning(
          warningSink,
          formatWarning(
            'SPIFFS',
            `file '${path}'`,
            `index table entry at span ${spanIx} references page ${pageIx} that is not live in object lookup`,
          ),
        );
        written += chunkLen;
        continue;
      }

      const dataPageOffset = pageIx << pageShift;
      const dataView = new DataView(
        image.buffer,
        image.byteOffset + dataPageOffset,
        config.pageSize,
      );

      // Validate the referenced data page belongs to this object
      const dpObjIdRaw = Number(readUint(dataView, 0, config.objIdLen, config.endianness));
      const dpSpanIx = Number(
        readUint(dataView, config.objIdLen, config.spanIxLen, config.endianness),
      );
      const dpFlags = Number(
        readUint(
          dataView,
          config.objIdLen + config.spanIxLen,
          SPIFFS_PH_FLAG_LEN,
          config.endianness,
        ),
      );
      const dpIsIndex = (dpObjIdRaw & msbMask) !== 0;
      const dpObjId = dpObjIdRaw & ~msbMask;

      if (dpIsIndex || dpObjId !== objId || dpFlags !== SPIFFS_PH_FLAG_USED_FINAL) {
        emitWarning(
          warningSink,
          formatWarning(
            'SPIFFS',
            `file '${path}'`,
            `data page at index ${pageIx} (span ${spanIx}) has mismatched header ` +
              `(objId=${dpObjId}, flags=0x${dpFlags.toString(16)}, isIndex=${dpIsIndex}), gap filled with zeros`,
          ),
        );
        written += chunkLen;
        continue;
      }

      if (dpSpanIx !== spanIx) {
        emitWarning(
          warningSink,
          formatWarning(
            'SPIFFS',
            `file '${path}'`,
            `data page at index ${pageIx} self-reports span ${dpSpanIx} but index table expects ${spanIx}`,
          ),
        );
      }

      const off = dataPageOffset + config.OBJ_DATA_PAGE_HEADER_LEN;
      content.set(image.subarray(off, off + chunkLen), written);
      written += chunkLen;
    }

    if (written < size) {
      emitWarning(
        warningSink,
        formatWarning(
          'SPIFFS',
          `file '${path}'`,
          `reconstructed ${written} of ${size} bytes, missing pages filled with zeros`,
        ),
      );
    }
    files.push({ path, size, content });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const root = buildTree(files);
  return { config, files, root, warnings: warningSink.warnings };
}

function assertFirstDataPageLooksSane(
  path: string,
  pageIndices: number[],
  neededPages: number,
  totalPages: number,
  pageIxLen: number,
): void {
  if (neededPages === 0) return;
  if (pageIndices.length === 0) {
    throw new Error(
      `SPIFFS file '${path}' has no usable index entries for non-empty content; ` +
        'parse options likely do not match the image layout',
    );
  }

  const firstPageIx = pageIndices[0]!;
  const freeMarker = (1 << (pageIxLen * 8)) - 1;
  if (firstPageIx === freeMarker) {
    throw new Error(
      `SPIFFS file '${path}' has an unset first data-page pointer (0x${freeMarker.toString(16)}); ` +
        'parse options likely do not match the image layout',
    );
  }

  if (firstPageIx >= totalPages) {
    throw new Error(
      `SPIFFS file '${path}' has an out-of-range first data-page pointer ${firstPageIx} ` +
        `(total pages ${totalPages}); parse options likely do not match the image layout`,
    );
  }
}

/**
 * Collect all page indices from a file's index pages (span 0, 1, 2, ...).
 * The first index page (span 0 / header) stores entries after the extended
 * header; subsequent index pages store entries right after the aligned base header.
 */
function collectPageIndices(
  indexSpans: Map<number, { absoluteOffset: number }>,
  config: SpiffsBuildConfig,
  image: Uint8Array,
  warningSink: WarningResult,
  path: string,
): number[] {
  const pageIndices: number[] = [];
  const sortedSpanIxs = [...indexSpans.keys()].sort((a, b) => a - b);
  let expectedSpanIx = 0;

  for (const spanIx of sortedSpanIxs) {
    const entry = indexSpans.get(spanIx)!;
    const view = new DataView(
      image.buffer,
      image.byteOffset + entry.absoluteOffset,
      config.pageSize,
    );

    if (spanIx !== expectedSpanIx) {
      emitWarning(
        warningSink,
        formatWarning(
          'SPIFFS',
          `file '${path}'`,
          `index page span ${expectedSpanIx} is missing, later spans will map to their SPIFFS-defined offsets`,
        ),
      );
    }

    let entriesOffset: number;
    let entriesLimit: number;
    let baseDataSpan: number;
    if (spanIx === 0) {
      entriesOffset = config.OBJ_INDEX_PAGES_HEADER_LEN_ALIGNED;
      entriesLimit = config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM;
      baseDataSpan = 0;
    } else {
      entriesOffset = config.OBJ_DATA_PAGE_HEADER_LEN_ALIGNED;
      entriesLimit = config.OBJ_INDEX_PAGES_OBJ_IDS_LIM;
      baseDataSpan =
        config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM + (spanIx - 1) * config.OBJ_INDEX_PAGES_OBJ_IDS_LIM;
    }

    for (let i = 0; i < entriesLimit; i++) {
      const off = entriesOffset + i * config.pageIxLen;
      if (off + config.pageIxLen > config.pageSize) break;
      const pageIx = Number(readUint(view, off, config.pageIxLen, config.endianness));
      pageIndices[baseDataSpan + i] = pageIx;
    }
    expectedSpanIx = spanIx + 1;
  }

  return pageIndices;
}

function decodeFileName(nameBytes: Uint8Array, warningSink: WarningResult, objId: number): string {
  // Find null terminator
  let end = nameBytes.indexOf(0);
  if (end < 0) {
    end = nameBytes.length;
    emitWarning(
      warningSink,
      formatWarning(
        'SPIFFS',
        `object ${objId}`,
        'file name is not NUL-terminated; ESP-IDF runtime open/stat compatibility may be unreliable',
      ),
    );
  }
  const raw = nameBytes.subarray(0, end);

  // Try strict UTF-8 decode first
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    // Fall back to replacement mode but emit a warning
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    emitWarning(
      warningSink,
      formatWarning(
        'SPIFFS',
        `object ${objId}`,
        `file name contains invalid UTF-8 bytes, decoded as '${decoded}'`,
      ),
    );
    return decoded;
  }
}

function pageCapacityForIndexSpans(
  indexSpans: Map<number, { absoluteOffset: number }>,
  config: SpiffsBuildConfig,
): number {
  let maxPages = 0;
  for (const spanIx of indexSpans.keys()) {
    const spanCapacity =
      spanIx === 0
        ? config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM
        : config.OBJ_INDEX_PAGES_OBJ_IDS_HEAD_LIM + spanIx * config.OBJ_INDEX_PAGES_OBJ_IDS_LIM;
    if (spanCapacity > maxPages) maxPages = spanCapacity;
  }
  return maxPages;
}

function imageMaxFileSize(totalPages: number, config: SpiffsBuildConfig): number {
  const blocks = Math.floor(totalPages / config.PAGES_PER_BLOCK);
  const usablePages = blocks * config.OBJ_USABLE_PAGES_PER_BLOCK;
  return usablePages * config.OBJ_DATA_PAGE_CONTENT_LEN;
}

function addIndexPage(
  store: Map<number, Map<number, { absoluteOffset: number }>>,
  objId: number,
  spanIx: number,
  value: { absoluteOffset: number },
  warningSink: WarningResult,
): void {
  let bucket = store.get(objId);
  if (!bucket) {
    bucket = new Map();
    store.set(objId, bucket);
  }
  if (bucket.has(spanIx)) {
    emitWarning(
      warningSink,
      formatWarning(
        'SPIFFS',
        `object ${objId} span ${spanIx}`,
        'duplicate index page detected, keeping the later page',
      ),
    );
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
