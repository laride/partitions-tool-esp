import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'partition-table/index': 'src/partition-table/index.ts',
    'nvs/index': 'src/nvs/index.ts',
    'spiffs/index': 'src/spiffs/index.ts',
    'fatfs/index': 'src/fatfs/index.ts',
    'io/node': 'src/io/node.ts',
    'io/browser': 'src/io/browser.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
  platform: 'node', // for src/io/node.ts
});
