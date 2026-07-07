// Pack ./payload into a SPIFFS image (matching our test defaults), then parse
// it back and print best-effort warnings/files.
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
  for (const warning of parsed.warnings) {
    console.warn('warning:', warning.message);
  }
  for (const f of parsed.files) {
    console.log(' - %s (%d bytes)', f.path, f.size);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
