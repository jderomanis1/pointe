import { defineConfig } from 'vitest/config';

// Node-runner config for the pure unit tests (broadcast, closeCodes,
// rateLimit, stats, worker). The DO-SQLite-dependent suites live under
// `*.workers.test.ts` and run via vitest.workers.config.ts on the real
// Cloudflare DO SQLite in workerd. Both configs run in `pnpm test`; this
// one excludes the workers glob, the pool config includes only it — no
// double-runs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.workers.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/worker.ts'],
    },
  },
});
