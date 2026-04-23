// Three equivalent ways to build the same NVS partition:
//   1) CSV (great for reuse of existing ESP-IDF definitions)
//   2) NvsBuilder fluent API
//   3) fromObject() with a plain JS object
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
`;
  const csvBin = NVS.generate(NVS.parseCSV(csv), { size });

  // 2) Fluent builder
  const builderBin = NVS.generate(
    new NVS.NvsBuilder()
      .namespace('storage')
      .string('greeting', 'hello world')
      .u32('counter', 42)
      .build(),
    { size },
  );

  // 3) Plain object (widths inferred; explicit { type, value } when needed)
  const objectBin = NVS.generate(
    NVS.fromObject({
      storage: {
        greeting: 'hello world',
        counter: 42, // inferred u32 (non-negative integer)
      },
    }),
    { size },
  );

  await writeFile('nvs.bin', builderBin);
  console.log('wrote nvs.bin (%d bytes)', builderBin.byteLength);

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
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
