import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary', 'json'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/io/**'],
    },
  },
});
