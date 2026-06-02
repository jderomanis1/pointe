import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default to node (pure tests). Component tests under *.test.tsx opt into
    // jsdom via a `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/store/**/*.ts'],
    },
  },
});
