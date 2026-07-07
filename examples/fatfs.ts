// Pack ./payload into a FAT image, optionally wrapped with wear leveling,
// then parse it back and print warnings/files.
// Run: pnpm tsx examples/fatfs.ts ./payload out.img [--wl] [--safe]
import { writeFile } from 'node:fs/promises';
import { FatFS } from '../src/index.js';
import { readDir } from '../src/io/node.js';

async function main(): Promise<void> {
  const [srcDir = './payload', outFile = 'out.img', ...flags] = process.argv.slice(2);
  const wearLeveling = flags.includes('--wl');
  const safeMode = flags.includes('--safe');
  const source = await readDir(srcDir);
  source.name = '';
  const img = FatFS.generate({
    size: wearLeveling ? 1024 * 1024 : 512 * 1024,
    source,
    sectorSize: wearLeveling ? FatFS.WL_SECTOR_SIZE : 4096,
    espIdfCompat: true,
    ...(wearLeveling ? { wearLeveling: { mode: safeMode ? 'safe' : 'perf' } } : {}),
  });
  await writeFile(outFile, img);
  console.log(
    'wrote %s (%d bytes, wl=%s, mode=%s)',
    outFile,
    img.byteLength,
    wearLeveling,
    wearLeveling ? (safeMode ? 'safe' : 'perf') : 'n/a',
  );

  const parsed = FatFS.parse(img, {
    wearLeveling: wearLeveling ? (safeMode ? 'safe' : 'perf') : false,
  });
  for (const warning of parsed.warnings) {
    console.warn('warning:', warning.message);
  }
  for (const { path, content } of FatFS.flatten(parsed.root)) {
    console.log(' - %s (%d bytes)', path, content.byteLength);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
