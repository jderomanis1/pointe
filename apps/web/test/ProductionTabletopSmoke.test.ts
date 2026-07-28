import { expect, test } from 'vitest';

const ORIGIN = 'https://pointe.team';
const EXPECTED_MARKERS = [
  'Flip the cards!',
  'Choose the card that feels right.',
  'The table is open',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

test('production serves the new tabletop room bundle', async () => {
  let lastObservation = 'No response received.';

  for (let attempt = 1; attempt <= 18; attempt += 1) {
    try {
      const html = await fetchText(`${ORIGIN}/?tabletop-smoke=${Date.now()}`);
      const scriptMatch = html.match(/<script[^>]+src=["']([^"']+\.js)["']/i);
      if (!scriptMatch) {
        lastObservation = 'Could not locate the production JavaScript bundle.';
      } else {
        const bundleUrl = new URL(scriptMatch[1], ORIGIN).toString();
        const bundle = await fetchText(`${bundleUrl}?tabletop-smoke=${Date.now()}`);
        const missing = EXPECTED_MARKERS.filter((marker) => !bundle.includes(marker));
        if (missing.length === 0) return;
        lastObservation = `Production bundle is missing: ${missing.join(', ')}`;
      }
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 18) await sleep(5_000);
  }

  expect.fail(`New tabletop bundle did not reach production. ${lastObservation}`);
}, 120_000);
