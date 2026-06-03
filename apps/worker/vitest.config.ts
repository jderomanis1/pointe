import { defineConfig } from 'vitest/config';

// Node-runner config for the legacy better-sqlite3 mock suite. The Workers-pool
// config (vitest.workers.config.ts) runs the migrated *.workers.test.ts files
// against real DO SQLite in workerd. Both run in `pnpm test`; the pool excludes
// non-migrated tests, this one excludes the migrated glob — no double-runs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.workers.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/worker.ts'], // Worker entry is integration territory, not unit
    },
  },
});
