from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    if old not in content:
        raise RuntimeError(f'Expected text missing from {path}: {old[:160]!r}')
    target.write_text(content.replace(old, new, 1))


# Deterministic injection point for collision-contract tests. Production keeps
# the default cryptographic generator.
patch(
    'apps/worker/src/slug.ts',
    "  roomId: string,\n  maxRetries = 5,\n): Promise<string> {\n  for (let attempt = 0; attempt < maxRetries; attempt++) {\n    const slug = generateSlug();",
    "  roomId: string,\n  maxRetries = 5,\n  slugFactory: () => string = generateSlug,\n): Promise<string> {\n  for (let attempt = 0; attempt < maxRetries; attempt++) {\n    const slug = slugFactory();",
)

# Tests that create a new protected identity must present its paired token when
# exercising the resume path.
patch(
    'apps/worker/test/dispatcher.workers.test.ts',
    "      addVoter(sql, { voterId: 'v-alice', displayName: 'Alice', now: NOW + 1 });",
    "      addVoter(sql, {\n        voterId: 'v-alice', displayName: 'Alice', resumeToken: 'resume-alice', now: NOW + 1,\n      });",
)
patch(
    'apps/worker/test/dispatcher.workers.test.ts',
    "      const out = handleMessage(sql, ws, joinEnv('join-r', { slug: 's', resumeVoterId: 'v-alice', role: 'voter' }));",
    "      const out = handleMessage(sql, ws, joinEnv('join-r', {\n        slug: 's', resumeVoterId: 'v-alice', resumeToken: 'resume-alice', role: 'voter',\n      }));",
)

patch(
    'apps/worker/test/operations.workers.test.ts',
    "  hostDisplayName: 'Host',\n  deck: 'fibonacci' as const,",
    "  hostDisplayName: 'Host',\n  hostResumeToken: 'host-resume-token',\n  deck: 'fibonacci' as const,",
)
patch(
    'apps/worker/test/operations.workers.test.ts',
    "        voterId: 'ignored', resumeVoterId: 'host-1',\n        displayName: 'ignored-too', role: 'spectator', now: NOW + 5,",
    "        voterId: 'ignored', resumeVoterId: 'host-1', resumeToken: 'host-resume-token',\n        displayName: 'ignored-too', role: 'spectator', now: NOW + 5,",
)

patch(
    'apps/worker/test/hostVacancy.workers.test.ts',
    "const HOST_ID = 'h-1';\nconst VOTER_ID = 'v-1';",
    "const HOST_ID = 'h-1';\nconst HOST_RESUME_TOKEN = 'host-resume-token';\nconst VOTER_ID = 'v-1';",
)
patch(
    'apps/worker/test/hostVacancy.workers.test.ts',
    "    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 1_000,",
    "    hostDisplayName: 'Alice', hostResumeToken: HOST_RESUME_TOKEN,\n    deck: 'fibonacci', mode: 'sync', now: 1_000,",
)
patch(
    'apps/worker/test/hostVacancy.workers.test.ts',
    "        payload: { slug: 'apt-sparrow-16', resumeVoterId: HOST_ID, role: 'voter' },",
    "        payload: {\n          slug: 'apt-sparrow-16', resumeVoterId: HOST_ID,\n          resumeToken: HOST_RESUME_TOKEN, role: 'voter',\n        },",
)

patch(
    'apps/worker/test/hostClaim.workers.test.ts',
    "const HOST_ID = 'h-1';\nconst VOTER_B = 'v-b';",
    "const HOST_ID = 'h-1';\nconst HOST_RESUME_TOKEN = 'host-resume-token';\nconst VOTER_B = 'v-b';",
)
patch(
    'apps/worker/test/hostClaim.workers.test.ts',
    "    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 1_000,",
    "    hostDisplayName: 'Alice', hostResumeToken: HOST_RESUME_TOKEN,\n    deck: 'fibonacci', mode: 'sync', now: 1_000,",
)
patch(
    'apps/worker/test/hostClaim.workers.test.ts',
    "    payload: { slug: 'apt-sparrow-16', resumeVoterId, role: 'voter' },",
    "    payload: {\n      slug: 'apt-sparrow-16', resumeVoterId,\n      ...(resumeVoterId === HOST_ID ? { resumeToken: HOST_RESUME_TOKEN } : {}),\n      role: 'voter',\n    },",
)

# The capstone intentionally canonicalizes non-deterministic transport values.
# Resume credentials are random transport metadata just like envelope IDs, not
# an AI-visible product difference.
patch(
    'apps/worker/test/aiIndistinguishability.workers.test.ts',
    "    if (typeof value === 'string') {\n      return UUID_RE.test(value) ? tok(value) : value;\n    }",
    "    if (typeof value === 'string') {\n      if (key === 'resumeToken') return 'RESUME_TOKEN';\n      return UUID_RE.test(value) ? tok(value) : value;\n    }",
)

old_race = '''describe('Race 1 — slug collision on creation (spec §13.1)', () => {
  it('reserveSlug retries on collision and returns a fresh slug', async () => {
    // Pre-seed the KV with whatever the FIRST attempt would generate, so
    // the retry path actually fires; the second attempt picks a different
    // pair (Math.random) and wins. To make this deterministic without
    // mocking Math.random we instead force every possible slug except one
    // — too large. Use Math.random seeding via spy.
    const kv = createMockKv();
    const seq = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99];
    let i = 0;
    const origRandom = Math.random;
    Math.random = () => seq[Math.min(i++, seq.length - 1)];
    try {
      // First call mints a slug and writes it.
      const first = await reserveSlug(kv, 'room-A', 5);
      expect(first).toMatch(/^[a-z]+-[a-z]+-\\d{2}$/);
      // Second call — random sequence now produces a different slug; previous
      // is still in KV from first call, so the retry-on-existing path runs
      // for any collision; this room gets its own slug.
      const second = await reserveSlug(kv, 'room-B', 5);
      expect(second).toMatch(/^[a-z]+-[a-z]+-\\d{2}$/);
      expect(second).not.toBe(first);
    } finally {
      Math.random = origRandom;
    }
  });

  it('exhausts after maxRetries collisions → throws SLUG_GENERATION_EXHAUSTED', async () => {
    // Pin every retry to the same generated slug → all 5 collide → throws.
    const kv = createMockKv();
    const origRandom = Math.random;
    Math.random = () => 0.0; // deterministic: same adj+noun+number every call
    try {
      const firstSlug = await reserveSlug(kv, 'room-X', 1);
      // Pre-seed the KV with the same slug under a different room id, so
      // the retry loop sees it as "taken" by some other room.
      // (firstSlug is already in KV — reserveSlug just wrote it.) Now any
      // further reserve attempts collide and the post-put re-read sees the
      // existing owner, not us → exhausts.
      await expect(reserveSlug(kv, 'room-Y', 5)).rejects.toThrow('SLUG_GENERATION_EXHAUSTED');
      expect(firstSlug).toMatch(/^[a-z]+-[a-z]+-\\d{2}$/);
    } finally {
      Math.random = origRandom;
    }
  });
});'''
new_race = '''describe('Race 1 — slug collision on creation (spec §13.1)', () => {
  it('reserveSlug retries on collision and returns a fresh secure slug', async () => {
    const kv = createMockKv();
    const collision = `calm-fox-owl-${'a'.repeat(24)}`;
    const fresh = `calm-fox-hawk-${'b'.repeat(24)}`;
    await kv.put(collision, 'existing-room');
    const candidates = [collision, fresh];
    let index = 0;
    const slug = await reserveSlug(
      kv,
      'room-B',
      5,
      () => candidates[Math.min(index++, candidates.length - 1)],
    );
    expect(slug).toBe(fresh);
  });

  it('exhausts after maxRetries collisions → throws SLUG_GENERATION_EXHAUSTED', async () => {
    const kv = createMockKv();
    const collision = `sure-ibex-hare-${'c'.repeat(24)}`;
    await kv.put(collision, 'existing-room');
    await expect(
      reserveSlug(kv, 'room-Y', 5, () => collision),
    ).rejects.toThrow('SLUG_GENERATION_EXHAUSTED');
  });
});'''
patch('apps/worker/test/raceConditions.workers.test.ts', old_race, new_race)

print('Hardened compatibility tests updated.')
