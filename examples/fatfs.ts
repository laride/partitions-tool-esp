// Pack ./payload into a 1 MB FAT image (with wear leveling) and read it back.
// Run: pnpm tsx examples/fatfs.ts ./payload out.img [--wl]
import { writeFile } from 'node:fs/promises';
import { FatFS } from '../src/index.js';
import { readDir } from '../src/io/node.js';

async function main(): Promise<void> {
  const [srcDir = './payload', outFile = 'out.img', ...flags] = process.argv.slice(2);
  const wearLeveling = flags.includes('--wl');
  const source = await readDir(srcDir);
  source.name = '';
  const img = FatFS.generate({
    size: wearLeveling ? 1024 * 1024 : 512 * 1024,
    source,
    sectorSize: wearLeveling ? FatFS.WL_SECTOR_SIZE : 4096,
    ...(wearLeveling ? { wearLeveling: true } : {}),
  });
  await writeFile(outFile, img);
  console.log('wrote %s (%d bytes, wl=%s)', outFile, img.byteLength, wearLeveling);

  const parsed = FatFS.parse(img, { wearLeveling });
  for (const { path, content } of FatFS.flatten(parsed.root)) {
    console.log(' - %s (%d bytes)', path, content.byteLength);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
