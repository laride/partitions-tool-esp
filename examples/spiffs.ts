// Pack ./payload into a SPIFFS image (matching spiffsgen.py defaults used by
// our tests) and read it back.
// Run: pnpm tsx examples/spiffs.ts ./payload out.bin
import { writeFile } from 'node:fs/promises';
import { SPIFFS } from '../src/index.js';
import { readDir } from '../src/io/node.js';

async function main(): Promise<void> {
  const [srcDir = './payload', outFile = 'out.bin'] = process.argv.slice(2);
  const source = await readDir(srcDir);
  const img = SPIFFS.generate({
    imageSize: 0x10000,
    pageSize: 256,
    objNameLen: 32,
    metaLen: 4,
    useMagic: true,
    useMagicLength: true,
    source,
  });
  await writeFile(outFile, img);
  console.log('wrote %s (%d bytes)', outFile, img.byteLength);

  const parsed = SPIFFS.parse(img, { pageSize: 256, objNameLen: 32, metaLen: 4 });
  for (const f of parsed.files) {
    console.log(' - %s (%d bytes)', f.path, f.size);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
