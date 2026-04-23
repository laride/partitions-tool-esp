// Generate and parse a 4 MB flash partition table.
// Run: pnpm tsx examples/partition-table.ts
import { writeFile } from 'node:fs/promises';
import { PartitionTable } from '../src/partition-table/index.js';

const csv = `# Name,   Type, SubType, Offset,   Size, Flags
nvs,      data, nvs,     ,        0x6000,
phy_init, data, phy,     ,        0x1000,
factory,  app,  factory, ,        1M,
`;

async function main(): Promise<void> {
  const table = PartitionTable.fromCSV(csv, { flashSize: 4 * 1024 * 1024 });
  console.log('parsed %d entries', table.entries.length);
  for (const e of table.entries) {
    console.log(
      ' - %s @ 0x%s size=0x%s',
      e.name.padEnd(8),
      (e.offset ?? 0).toString(16).padStart(6, '0'),
      e.size.toString(16),
    );
  }

  const bin = table.toBinary();
  await writeFile('partitions.bin', bin);
  console.log('wrote partitions.bin (%d bytes)', bin.byteLength);

  const round = PartitionTable.fromBinary(bin);
  console.log('round-trip CSV:\n%s', round.toCSV());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
