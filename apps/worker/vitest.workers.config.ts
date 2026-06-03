import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Workers-pool config: runs *.workers.test.ts in workerd against real DO
 * SQLite. v0.16.x ships the integration as a vitest plugin (cloudflareTest),
 * not a config helper — the documented `/config` subpath isn't published.
 * Reads wrangler.toml for the ROOM DO + SQLite-class migration bindings.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  test: {
    include: ['test/**/*.workers.test.ts'],
  },
});
