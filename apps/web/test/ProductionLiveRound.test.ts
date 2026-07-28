import { expect, it } from 'vitest';

async function fetchTextWithRetry(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 18; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw lastError;
}

it('serves the live-only planning poker release from pointe.team', async () => {
  const html = await fetchTextWithRetry('https://pointe.team/');
  expect(html).toContain('Free Live Planning Poker for Agile Teams');

  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(asset).toBeTruthy();
  const bundle = await fetchTextWithRetry(`https://pointe.team${asset}`);

  expect(bundle).toContain('Join the room. Pick a card. Keep moving.');
  expect(bundle).toContain('Reveal cards');
  expect(bundle).toContain('Close vote');
  expect(bundle).toContain('Opening the vote');
  expect(bundle).not.toContain('Open async voting');
}, 120_000);
