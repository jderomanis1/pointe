/**
 * S10 — 10-Voter Concurrency Soak (manually-runnable artifact).
 *
 * What this verifies: a realistic full refinement session at capacity —
 * 1 host + 10 voters casting simultaneously across 12 stories in SYNC mode
 * (sync's "everyone votes on the active story at once" is the worst-case DO
 * contention). It is a CONCURRENCY check, not a network/edge check, so it
 * runs against the LOCAL wrangler stack. Worker-level behaviour is
 * byte-identical between local stack and prod; localhost-vs-edge is
 * irrelevant to "can this code survive concurrency".
 *
 * Posture:
 *   • protocol-level — the SUT is the DO/worker, driven as raw WS protocol
 *     clients (node `ws`), NOT browser contexts (that is e2e's job).
 *   • determinism — the concurrent cast is `Promise.all`'d (fire the burst,
 *     don't serialize), but EVERY wait is on observable state (the DO
 *     reflecting N votes / a reveal landing), never wall-clock. Timeouts
 *     exist only as a failure failsafe, never as a pass-gate.
 *
 * Gate exclusion: this is a ONE-TIME sanity check, not a CI gate. It is
 * excluded from both the per-push gate and the nightly e2e — run it by hand
 * with `pnpm soak` against a running local stack (`pnpm -F @pointe/worker
 * dev:e2e`).
 *
 * WS-concurrency-limit recon (Step 1): the SI-06 WS limit is an IN-WORKER DO
 * atomic counter, but it is a per-IP/per-room HANDSHAKE RATE of 30/min
 * (RL_WS_PER_MIN), NOT a concurrency cap — the "10 concurrent WS/IP" spec
 * line was deliberately reinterpreted (see /spec/security.md §1). The soak's
 * 11 handshakes (host + 10 voters) from one IP in one room within a minute
 * are well under 30, so the limit is NOT tripped and NO dev override is
 * needed. Each re-run creates a fresh room → a fresh DO → a fresh counter,
 * so re-runs don't accumulate against the per-room window either. (The
 * create-per-hour KV cap is bumped to 500 in wrangler.dev.toml; a single
 * soak run creates one room.)
 */

import { WebSocket } from 'ws';
// Reuse the SAME pure stats function the worker uses at reveal — so the soak
// verifies the full server plumbing (votes stored + reveal wiring) and not a
// re-implementation. The stats MATH itself is unit-tested separately; here it
// is the oracle, cross-checked against independent hand-coded expectations.
import { computeRevealStats, resolveDeck } from '../packages/shared/src/stats.ts';

const BASE = process.env.SOAK_BASE ?? 'http://127.0.0.1:8787';
const WSBASE = BASE.replace(/^http/, 'ws');
const PROTOCOL_VERSION = 1;
const N_VOTERS = 10;
const DECK = 'fibonacci';
const deck = resolveDeck(DECK, null); // ['1','2','3','5','8','13','21']

// ---- tiny protocol helpers (envelope shape per @pointe/shared) -------------

const uid = () => crypto.randomUUID();
function buildEnvelope(type, payload, id = uid()) {
  return { id, raw: JSON.stringify({ v: PROTOCOL_VERSION, type, id, at: Date.now(), payload }) };
}

// ---- assertion harness -----------------------------------------------------

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
function eq(actual, expected, msg) {
  check(actual === expected, `${msg} — expected ${expected}, got ${actual}`);
}

// ---- WS client wrapper -----------------------------------------------------

/** One protocol client. Buffers every DELTA change it receives, tagged so
 *  AA-1 leakage and vote-landing can be asserted from observable state. */
class Client {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.voterId = null;
    this.role = null;
    this.changes = []; // flat list of every DeltaChange this socket received
    this.serverMsgs = []; // non-DELTA server messages
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'DELTA') {
        for (const c of m.payload.changes) this.changes.push(c);
      } else {
        this.serverMsgs.push(m);
      }
    });
  }

  send(env) { this.ws.send(env.raw); }

  join(payload) {
    return new Promise((res, rej) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'SNAPSHOT_RESPONSE') {
          this.ws.off('message', onMsg);
          this.voterId = m.payload.you.voterId;
          this.role = m.payload.you.role;
          res(m.payload);
        }
      };
      this.ws.on('message', onMsg);
      this.send(buildEnvelope('JOIN_ROOM', payload));
      setTimeout(() => rej(new Error(`${this.label} JOIN timeout`)), 5000);
    });
  }

  close() { try { this.ws.close(1000, 'soak done'); } catch { /* ignore */ } }
}

function connect(slug, label) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/api/rooms/${slug}/ws`);
    ws.on('open', () => res(new Client(ws, label)));
    ws.on('error', rej);
  });
}

/** Wait on observable state. `pred` is polled until true or the failsafe
 *  timeout trips (timeout === failure, never a pass-gate). */
function waitUntil(pred, label, timeoutMs = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(Date.now() - t0); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        rej(new Error(`TIMEOUT waiting for: ${label}`));
      }
    }, 10);
  });
}

// ---- the 12 seeded distributions ------------------------------------------
// Each yields exactly 10 votes. `expect` is the INDEPENDENT hand-derived
// truth (asserted against the server) — distinct from the computeRevealStats
// oracle so the check isn't circular. Deck positions:
//   1→0  2→1  3→2  5→3  8→4  13→5  21→6
function rep(points, confidence, n) {
  return Array.from({ length: n }, () => ({ points, confidence }));
}
const STORIES = [
  { label: 'tight consensus 5 / high conf',
    votes: rep('5', 5, 10),
    expect: { median: '5', outlierCount: 0, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
  { label: 'tight consensus 3 / conf 4',
    votes: rep('3', 4, 10),
    expect: { median: '3', outlierCount: 0, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
  { label: 'wide spread with low+high outliers',
    votes: [...rep('5', 3, 6), ...rep('1', 3, 2), ...rep('21', 3, 2)],
    expect: { median: '5', outlierCount: 4, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
  { label: 'low-confidence consensus on 8',
    votes: rep('8', 2, 10),
    expect: { median: '8', outlierCount: 0, lowConfidence: true, nonNumericCount: 0, numericCount: 10 } },
  { label: 'low-confidence spread 8/13',
    votes: [...rep('8', 2, 5), ...rep('13', 1, 5)],
    expect: { median: '8', outlierCount: 0, lowConfidence: true, nonNumericCount: 0, numericCount: 10 } },
  { label: 'non-numeric mix (8x5 + 2x?)',
    votes: [...rep('5', 4, 8), ...rep('?', 3, 2)],
    expect: { median: '5', outlierCount: 0, lowConfidence: false, nonNumericCount: 2, numericCount: 8 } },
  { label: 'single high outlier (9x3 + 1x21)',
    votes: [...rep('3', 4, 9), ...rep('21', 4, 1)],
    expect: { median: '3', outlierCount: 1, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
  { label: 'bimodal 2/13 (median lands on un-voted card)',
    votes: [...rep('2', 3, 5), ...rep('13', 3, 5)],
    expect: { median: '5', outlierCount: 10, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
  { label: 'tight consensus 21 / high conf',
    votes: rep('21', 5, 10),
    expect: { median: '21', outlierCount: 0, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
  { label: 'asymmetric tail (7x5 2x8 1x13)',
    votes: [...rep('5', 4, 7), ...rep('8', 4, 2), ...rep('13', 4, 1)],
    expect: { median: '5', outlierCount: 1, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
  { label: 'low-confidence consensus on 2',
    votes: rep('2', 1, 10),
    expect: { median: '2', outlierCount: 0, lowConfidence: true, nonNumericCount: 0, numericCount: 10 } },
  { label: 'mixed realistic (4x5 3x8 2x3 1x13)',
    votes: [...rep('5', 3, 4), ...rep('8', 4, 3), ...rep('3', 2, 2), ...rep('13', 5, 1)],
    expect: { median: '5', outlierCount: 1, lowConfidence: false, nonNumericCount: 0, numericCount: 10 } },
];

// ---- run -------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log(`\n=== S10 soak — ${N_VOTERS} voters, ${STORIES.length} stories, sync mode, local stack ===\n`);

  // 1. Create the room (sync). The create response carries the host voterId.
  const createRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostDisplayName: 'SoakHost', deck: DECK, mode: 'sync' }),
  });
  if (!createRes.ok) throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`);
  const { slug, voterId: hostId } = await createRes.json();
  console.log(`room ${slug} (host ${hostId.slice(0, 8)})`);

  // 2. Host + 10 voters join (11 WS from one IP — under the 30/min handshake rate).
  const host = await connect(slug, 'host');
  const hsnap = await host.join({ slug, resumeVoterId: hostId, role: 'voter' });
  eq(hsnap.you.role, 'host', 'host binds as host role');

  const voters = [];
  for (let i = 0; i < N_VOTERS; i++) {
    const c = await connect(slug, `v${i}`);
    await c.join({ slug, displayName: `Voter ${i}`, role: 'voter' });
    voters.push(c);
  }
  const voterIds = new Set(voters.map((v) => v.voterId));
  eq(voterIds.size, N_VOTERS, 'all 10 voters have distinct ids');
  console.log(`joined: host + ${voters.length} voters (${voters.length + 1} sockets, 1 IP)`);

  // 3. Host adds 12 stories; learn each id from the story_added broadcast.
  for (let i = 0; i < STORIES.length; i++) {
    host.send(buildEnvelope('ADD_STORY', { text: STORIES[i].label }));
  }
  await waitUntil(
    () => host.changes.filter((c) => c.kind === 'story_added').length >= STORIES.length,
    'all 12 stories added',
  );
  const storyIds = host.changes.filter((c) => c.kind === 'story_added').map((c) => c.story.id);
  eq(storyIds.length, STORIES.length, '12 stories created');

  const perStory = [];
  let aa1Leaks = 0;

  // 4. Per story: OPEN_VOTING → concurrent burst → wait on all 10 → REVEAL → COMMIT.
  for (let s = 0; s < STORIES.length; s++) {
    const story = STORIES[s];
    const storyId = storyIds[s];
    const sStart = Date.now();

    // mark a baseline so we only inspect changes from THIS story's burst
    const baseline = new Map([[host, host.changes.length], ...voters.map((v) => [v, v.changes.length])]);

    host.send(buildEnvelope('OPEN_VOTING', { storyId }));
    await waitUntil(
      () => host.changes.some((c, i) => i >= baseline.get(host) && c.kind === 'voting_opened' && c.storyId === storyId),
      `story ${s} voting opened`,
    );

    // Fire the burst — Promise.all, NOT serialized. Record each voter's
    // envelope id so we can test idempotency on story 0.
    const sentIds = [];
    const burstStart = Date.now();
    await Promise.all(voters.map((v, i) => {
      const env = buildEnvelope('VOTE_CAST', { storyId, points: story.votes[i].points, confidence: story.votes[i].confidence });
      sentIds[i] = env.id;
      v.send(env);
      return Promise.resolve();
    }));

    // Wait on OBSERVABLE state: the host (presence-only) must reflect all 10
    // distinct voters' voter_voted for THIS story before we reveal.
    const castLatency = await waitUntil(() => {
      const seen = new Set(
        host.changes
          .filter((c) => c.kind === 'voter_voted' && c.storyId === storyId)
          .map((c) => c.voterId),
      );
      return [...voterIds].every((id) => seen.has(id));
    }, `story ${s}: all 10 voter_voted observed by host`);
    const burstMs = Date.now() - burstStart;

    // Idempotency under load (story 0 only): re-fire voter 0's EXACT envelope
    // id but with a mutated payload. The 5-min dedupe must drop it — voter 0's
    // stored vote must stay the original, and no extra broadcast must appear.
    if (s === 0) {
      const before = host.changes.filter((c) => c.kind === 'voter_voted' && c.storyId === storyId).length;
      const dup = buildEnvelope('VOTE_CAST', { storyId, points: '21', confidence: 1 }, sentIds[0]);
      voters[0].send(dup);
      // give the DO a chance to (wrongly) re-broadcast; we then assert it did not
      await waitUntil(() => true, 'idempotency settle', 250).catch(() => {});
      const after = host.changes.filter((c) => c.kind === 'voter_voted' && c.storyId === storyId).length;
      eq(after, before, 'idempotency: re-fired duplicate envelope id produced NO new broadcast');
    }

    // AA-1 under load: no socket may receive a vote_value that isn't its own.
    // Each VOTER must see exactly ONE vote_value (its own cast, matching value);
    // the HOST must see ZERO vote_value before reveal.
    const hostValues = host.changes.slice(baseline.get(host)).filter((c) => c.kind === 'vote_value');
    if (hostValues.length !== 0) { aa1Leaks += hostValues.length; }
    check(hostValues.length === 0, `story ${s}: host received ${hostValues.length} vote_value pre-reveal (AA-1 leak)`);
    for (let i = 0; i < voters.length; i++) {
      const vv = voters[i].changes.slice(baseline.get(voters[i])).filter((c) => c.kind === 'vote_value');
      if (vv.length !== 1) { aa1Leaks += Math.abs(vv.length - 1); }
      check(vv.length === 1, `story ${s} voter ${i}: saw ${vv.length} vote_value (expected exactly its own)`);
      if (vv.length >= 1) {
        const expV = story.votes[i];
        check(
          vv[0].points === expV.points && vv[0].confidence === expV.confidence,
          `story ${s} voter ${i}: own vote_value mismatch (got ${vv[0].points}/${vv[0].confidence}, cast ${expV.points}/${expV.confidence})`,
        );
      }
    }

    // No reveal must have happened before all votes landed.
    const earlyReveal = host.changes
      .slice(baseline.get(host))
      .some((c) => c.kind === 'votes_revealed' && c.storyId === storyId);
    check(!earlyReveal, `story ${s}: reveal observed BEFORE all votes landed (ordering corruption)`);

    // REVEAL_VOTES → votes_revealed carries the full votes[] + stats.
    host.send(buildEnvelope('REVEAL_VOTES', { storyId }));
    const revealLatency = await waitUntil(
      () => host.changes.some((c) => c.kind === 'votes_revealed' && c.storyId === storyId),
      `story ${s}: reveal landed`,
    );
    const reveal = host.changes.find((c) => c.kind === 'votes_revealed' && c.storyId === storyId);

    // ---- assertions: no lost votes + stats correct under load --------------
    eq(reveal.votes.length, N_VOTERS, `story ${s}: all 10 votes present at reveal (no lost votes)`);
    const stats = reveal.stats;
    // Independent hand-derived expectations:
    eq(stats.median, story.expect.median, `story ${s}: median`);
    eq(stats.outliers.length, story.expect.outlierCount, `story ${s}: outlier count`);
    eq(stats.lowConfidence, story.expect.lowConfidence, `story ${s}: lowConfidence flag`);
    eq(stats.nonNumeric.length, story.expect.nonNumericCount, `story ${s}: non-numeric count`);
    eq(stats.numericCount, story.expect.numericCount, `story ${s}: numericCount`);
    // Oracle cross-check: server stats === computeRevealStats over the seeded votes.
    const oracle = computeRevealStats(deck, reveal.votes.map((v) => ({
      storyId, voterId: v.voterId, points: v.points, confidence: v.confidence, submittedAt: 0, updatedAt: 0,
    })));
    check(
      oracle.median === stats.median
      && oracle.outliers.length === stats.outliers.length
      && oracle.avgConfidence === stats.avgConfidence
      && oracle.lowConfidence === stats.lowConfidence
      && oracle.numericCount === stats.numericCount,
      `story ${s}: server stats match computeRevealStats oracle`,
    );

    // COMMIT_STORY closes the loop (use median, or '?' fallback for the
    // all-numeric stories — all our medians are real cards).
    host.send(buildEnvelope('COMMIT_STORY', { storyId, finalEstimate: stats.median ?? '?' }));
    await waitUntil(
      () => host.changes.some((c) => c.kind === 'story_committed' && c.storyId === storyId),
      `story ${s}: committed`,
    );

    const storyMs = Date.now() - sStart;
    perStory.push({ s, label: story.label, castLatency, burstMs, revealLatency, storyMs, median: stats.median, outliers: stats.outliers.length, avgConf: stats.avgConfidence });
    console.log(
      `  story ${String(s + 1).padStart(2)}/12  ${story.label.padEnd(46)}  ` +
      `votes=10 median=${String(stats.median).padStart(2)} out=${stats.outliers.length} ` +
      `lowConf=${stats.lowConfidence ? 'Y' : 'N'} | cast=${castLatency}ms reveal=${revealLatency}ms story=${storyMs}ms`,
    );
  }

  // DO-health: no ERROR server message should have reached any socket.
  const allErrors = [host, ...voters].flatMap((c) => c.serverMsgs.filter((m) => m.type === 'ERROR'));
  check(allErrors.length === 0, `DO emitted ${allErrors.length} ERROR message(s): ${JSON.stringify(allErrors.slice(0, 3))}`);

  // teardown
  host.close();
  voters.forEach((v) => v.close());

  const totalMs = Date.now() - t0;
  const castLats = perStory.map((p) => p.castLatency);
  const revealLats = perStory.map((p) => p.revealLatency);
  const storyLats = perStory.map((p) => p.storyMs);
  const summarize = (a) => ({ min: Math.min(...a), max: Math.max(...a), avg: Math.round(a.reduce((x, y) => x + y, 0) / a.length) });

  console.log(`\n--- timing ---`);
  console.log(`total loop: ${totalMs}ms over ${STORIES.length} stories`);
  console.log(`cast→all-10 latency:  ${JSON.stringify(summarize(castLats))} ms`);
  console.log(`reveal latency:       ${JSON.stringify(summarize(revealLats))} ms`);
  console.log(`per-story duration:   ${JSON.stringify(summarize(storyLats))} ms`);
  console.log(`drift story 1→12 (story duration): ${storyLats[0]}ms → ${storyLats[storyLats.length - 1]}ms`);
  console.log(`AA-1 leaks observed: ${aa1Leaks}`);

  console.log(`\n--- result ---`);
  console.log(`assertions run: ${checks}`);
  if (failures.length === 0) {
    console.log(`SOAK PASSED — all ${checks} assertions held.\n`);
    process.exit(0);
  } else {
    console.log(`SOAK FAILED — ${failures.length} assertion(s):`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nSOAK ERRORED:', err.stack ?? err);
  process.exit(1);
});
