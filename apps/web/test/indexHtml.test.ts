/**
 * S10.vii — Cloudflare Web Analytics beacon shape lock.
 *
 * The beacon snippet on `index.html` is the load-bearing piece of the
 * "Web Analytics is cookieless" promise. Three things have to stay true:
 *
 *   1. The script tag exists at all (the beacon mounts).
 *   2. It points at `static.cloudflareinsights.com/beacon.min.js` —
 *      the cookieless variant. The cookie-setting variant is a different
 *      file path; routing through the wrong URL is the failure mode here.
 *   3. The token is supplied via the standard `data-cf-beacon` JSON
 *      attribute (the placeholder is a one-step CF-dashboard config Joe
 *      completes — the placeholder itself is no-op, not a privacy leak).
 *
 * This test guards the shape — a future careless commit that drops the
 * snippet, or swaps it for a cookie-based product, trips here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(HERE, '..', 'index.html'), 'utf8');

describe('S10.vii — Cloudflare Web Analytics beacon (cookieless)', () => {
  it('the beacon script tag is present in index.html', () => {
    expect(HTML).toContain('static.cloudflareinsights.com/beacon.min.js');
  });

  it('uses the cookieless `beacon.min.js` script, NOT a cookie-setting variant', () => {
    // The cookie-setting product is at a different URL family
    // (e.g. *.cloudflareanalytics.com / *.cloudflarestream.com). Lock
    // the exact insights-cookieless host so a future "let's just swap
    // analytics providers" PR can't quietly violate §17.
    expect(HTML).toMatch(/src=["']https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js["']/);
  });

  it('wires the token via the documented `data-cf-beacon` attribute', () => {
    expect(HTML).toMatch(/data-cf-beacon=['"][^'"]*"token"\s*:/);
  });

  it('the snippet is `defer`red so it never blocks the SPA bootstrap', () => {
    // The beacon must not delay first paint or the WS connect. `defer`
    // is the documented attribute on the snippet.
    expect(HTML).toMatch(/<script\s+defer[\s\S]+beacon\.min\.js/);
  });
});
