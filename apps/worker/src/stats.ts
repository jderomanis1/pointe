import type { DeckType, RevealStats, Vote } from '@pointe/shared';

/**
 * Reveal-time stats per OQ-008 (resolved 2026-05-29):
 *  - Median basis: deck POSITION (not numeric value). Mapped back to a real deck card.
 *  - Even-count rounding: nearer real card; ties (a vote between two adjacent positions) → LOWER index.
 *  - Non-numeric votes (`?`, `∞`, anything not in the deck): excluded from median + outlier math,
 *    surfaced separately as a "needs discussion" flag.
 *  - Outliers: strictly more than 1 deck position from the median. Adjacent cards are NOT outliers.
 *  - lowConfidence: avgConfidence below LOW_CONFIDENCE_THRESHOLD triggers the
 *    "may need more refinement" flag (Pillar 3).
 *
 * Pure: no SQL, no IO, no clock. Deterministic.
 */

export const LOW_CONFIDENCE_THRESHOLD = 2.5;

// Canonical deck card sets. Order = deck-position order.
const DECKS = {
  fibonacci: ['1', '2', '3', '5', '8', '13', '21'],
  modFibonacci: ['0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100'],
  tshirt: ['XS', 'S', 'M', 'L', 'XL'],
  powers2: ['1', '2', '4', '8', '16', '32', '64'],
} as const;

/** Resolve a Room's deck declaration to the ordered card array. */
export function resolveDeck(deck: DeckType, customDeck: string[] | null | undefined): string[] {
  if (deck === 'custom') return customDeck ?? [];
  return [...DECKS[deck]];
}

export function computeRevealStats(deck: string[], votes: Vote[]): RevealStats {
  const numeric: { voterId: string; index: number; confidence: number }[] = [];
  const nonNumeric: string[] = [];

  for (const v of votes) {
    const idx = deck.indexOf(v.points);
    if (idx === -1) {
      nonNumeric.push(v.voterId);
    } else {
      numeric.push({ voterId: v.voterId, index: idx, confidence: v.confidence });
    }
  }

  const numericCount = numeric.length;
  if (numericCount === 0) {
    return {
      median: null,
      outliers: [],
      avgConfidence: null,
      lowConfidence: false,
      nonNumeric,
      numericCount: 0,
    };
  }

  // Median over deck positions; even-count rounds to nearer card; ties → lower index.
  const sortedIdx = numeric.map((n) => n.index).sort((a, b) => a - b);
  let medianIndex: number;
  if (sortedIdx.length % 2 === 1) {
    medianIndex = sortedIdx[Math.floor(sortedIdx.length / 2)];
  } else {
    const lo = sortedIdx[sortedIdx.length / 2 - 1];
    const hi = sortedIdx[sortedIdx.length / 2];
    // Math.floor((lo+hi)/2): when avg is integer (same-parity indices) returns it; when avg is
    // n+0.5 (ties between adjacent cards), returns n — the lower index, per OQ-008.
    medianIndex = Math.floor((lo + hi) / 2);
  }
  const median = deck[medianIndex];

  const outliers = numeric
    .filter((n) => Math.abs(n.index - medianIndex) > 1)
    .map((n) => n.voterId);

  const totalConfidence = numeric.reduce((s, n) => s + n.confidence, 0);
  const avgConfidence = totalConfidence / numericCount;
  const lowConfidence = avgConfidence < LOW_CONFIDENCE_THRESHOLD;

  return { median, outliers, avgConfidence, lowConfidence, nonNumeric, numericCount };
}
