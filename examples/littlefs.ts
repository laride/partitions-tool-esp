// Pack ./payload into a LittleFS image and parse it back.
// Run: pnpm tsx examples/littlefs.ts ./payload out.bin
import { writeFile } from 'node:fs/promises';
import { LittleFS } from '../src/index.js';
import { readDir } from '../src/io/node.js';

async function main(): Promise<void> {
  const [srcDir = './payload', outFile = 'out.bin'] = process.argv.slice(2);
  const source = await readDir(srcDir);
  const img = LittleFS.generate({
    imageSize: 0x10000,
    blockSize: 4096,
    readSize: 16,
    progSize: 16,
    inlineMax: 512,
    source,
  });
  await writeFile(outFile, img);
  console.log('wrote %s (%d bytes)', outFile, img.byteLength);

  const parsed = LittleFS.parse(img);
  console.log(
    'superblock: version=%d blockSize=%d blockCount=%d',
    parsed.superblock.version,
    parsed.superblock.blockSize,
    parsed.superblock.blockCount,
  );
  for (const warning of parsed.warnings) {
    console.warn('warning:', warning.message);
  }
  for (const file of parsed.files) {
    console.log(' - %s (%d bytes)', file.path, file.size);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
