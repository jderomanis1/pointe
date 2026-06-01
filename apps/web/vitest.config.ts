import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // pure-function tests; no DOM needed for the reducer
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/store/**/*.ts'],
    },
  },
});
