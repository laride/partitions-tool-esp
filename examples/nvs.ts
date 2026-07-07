// Build, encrypt, and parse an NVS partition using the current API surface:
//   1) CSV (great for existing ESP-IDF definitions)
//   2) NvsBuilder fluent API
//   3) fromObject() with a plain JS object
//   4) Optional AES-256-XTS encryption
//
// Run: pnpm tsx examples/nvs.ts
import { writeFile } from 'node:fs/promises';
import { NVS } from '../src/index.js';

const size = 0x6000;

async function main(): Promise<void> {
  // 1) CSV
  const csv = `key,type,encoding,value
storage,namespace,,
greeting,data,string,hello world
counter,data,u32,42
ratio,data,float,1.5
`;
  const csvBin = NVS.generate(NVS.parseCSV(csv), { size });

  // 2) Fluent builder
  const builderBin = NVS.generate(
    new NVS.NvsBuilder()
      .namespace('storage')
      .string('greeting', 'hello world')
      .u32('counter', 42)
      .float('ratio', 1.5)
      .build(),
    { size },
  );

  // 3) Plain object (widths inferred; explicit { type, value } when needed)
  const objectBin = NVS.generate(
    NVS.fromObject({
      storage: {
        greeting: 'hello world',
        counter: 42, // inferred u32 (non-negative integer)
        blob: { type: 'binary', value: 'deadbeef', encoding: 'hex2bin' },
      },
    }),
    { size },
  );

  const encryptionKey = NVS.generateNvsKey();
  const encryptedBin = NVS.generate(NVS.parseCSV(csv), {
    size,
    encryptionKey,
  });
  const keyPartition = NVS.serializeNvsKeyPartition(encryptionKey);

  await writeFile('nvs.bin', builderBin);
  await writeFile('nvs_encrypted.bin', encryptedBin);
  await writeFile('nvs_keys.bin', keyPartition);
  console.log('wrote nvs.bin (%d bytes)', builderBin.byteLength);
  console.log('wrote nvs_encrypted.bin (%d bytes)', encryptedBin.byteLength);
  console.log('wrote nvs_keys.bin (%d bytes)', keyPartition.byteLength);

  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
    a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
  console.log('csv == builder :', bytesEqual(csvBin, builderBin));
  console.log('csv == object  :', bytesEqual(csvBin, objectBin));

  const dump = NVS.parse(builderBin);
  for (const page of dump.pages) {
    for (const item of page.entries) {
      if (item.state === 'Written') {
        console.log('  [%s] %s.%s = %o', item.type, 'storage', item.key, item.data);
      }
    }
  }

  const encryptedDump = NVS.parse(encryptedBin, { decryptionKey: encryptionKey });
  console.log('encrypted parse warnings:', encryptedDump.warnings.length);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
