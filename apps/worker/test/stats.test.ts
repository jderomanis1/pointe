import { describe, it, expect } from 'vitest';
import { computeRevealStats, resolveDeck, LOW_CONFIDENCE_THRESHOLD } from '../src/stats';
import type { Vote } from '@pointe/shared';

const FIB = ['1', '2', '3', '5', '8', '13', '21'];

function vote(voterId: string, points: string, confidence: number): Vote {
  return { storyId: 's-1', voterId, points, confidence, submittedAt: 0, updatedAt: 0 };
}

describe('computeRevealStats — OQ-008 matrix', () => {
  it('all same (5,5,5): median 5, no outliers', () => {
    const stats = computeRevealStats(FIB, [
      vote('A', '5', 4), vote('B', '5', 4), vote('C', '5', 4),
    ]);
    expect(stats.median).toBe('5');
    expect(stats.outliers).toEqual([]);
    expect(stats.numericCount).toBe(3);
    expect(stats.nonNumeric).toEqual([]);
    expect(stats.avgConfidence).toBe(4);
    expect(stats.lowConfidence).toBe(false);
  });

  it('odd count clear middle (3,5,8): median 5, no outliers (all within 1 position)', () => {
    const stats = computeRevealStats(FIB, [
      vote('A', '3', 3), vote('B', '5', 3), vote('C', '8', 3),
    ]);
    expect(stats.median).toBe('5');
    expect(stats.outliers).toEqual([]);
  });

  it('even count round-to-nearer (5,8): tie → LOWER index → median 5', () => {
    // Indices 3,4 → avg 3.5 → tie → floor → 3 → deck[3] = "5"
    const stats = computeRevealStats(FIB, [vote('A', '5', 3), vote('B', '8', 3)]);
    expect(stats.median).toBe('5');
    // Adjacent NOT outlier: 8 is exactly 1 position from median → not an outlier.
    expect(stats.outliers).toEqual([]);
  });

  it('even count non-tie (3,8): avg index = 3 → median 5', () => {
    // Indices 2,4 → avg 3 (exact integer) → deck[3] = "5"
    const stats = computeRevealStats(FIB, [vote('A', '3', 3), vote('B', '8', 3)]);
    expect(stats.median).toBe('5');
  });

  it('outlier (5,5,5,21): 21 is strictly >1 position from median 5 → outlier', () => {
    const stats = computeRevealStats(FIB, [
      vote('A', '5', 4), vote('B', '5', 4), vote('C', '5', 4), vote('D', '21', 4),
    ]);
    expect(stats.median).toBe('5');
    expect(stats.outliers).toEqual(['D']);
  });

  it('adjacent NOT outlier (5,8): 8 is 1 position from median → not an outlier', () => {
    // Same as the round-to-nearer test but make the assertion explicit.
    const stats = computeRevealStats(FIB, [vote('A', '5', 3), vote('B', '8', 3)]);
    expect(stats.median).toBe('5');
    expect(stats.outliers).toEqual([]);
  });

  it('non-numeric excluded (5,5,?): median over numerics; ? in nonNumeric', () => {
    const stats = computeRevealStats(FIB, [
      vote('A', '5', 4), vote('B', '5', 4), vote('C', '?', 4),
    ]);
    expect(stats.median).toBe('5');
    expect(stats.outliers).toEqual([]);
    expect(stats.nonNumeric).toEqual(['C']);
    expect(stats.numericCount).toBe(2);
    // avgConfidence excludes the non-numeric voter — only 2 numerics with confidence 4 each.
    expect(stats.avgConfidence).toBe(4);
  });

  it('all non-numeric (?,?): median null; numericCount 0; both in nonNumeric', () => {
    const stats = computeRevealStats(FIB, [vote('A', '?', 4), vote('B', '∞', 4)]);
    expect(stats.median).toBeNull();
    expect(stats.outliers).toEqual([]);
    expect(stats.avgConfidence).toBeNull();
    expect(stats.lowConfidence).toBe(false);
    expect(stats.nonNumeric).toEqual(['A', 'B']);
    expect(stats.numericCount).toBe(0);
  });

  it('lowConfidence: avg below threshold flips the flag', () => {
    // confidence 2,2,2 → avg 2 < 2.5 → lowConfidence true
    const low = computeRevealStats(FIB, [
      vote('A', '5', 2), vote('B', '5', 2), vote('C', '5', 2),
    ]);
    expect(low.avgConfidence).toBe(2);
    expect(low.lowConfidence).toBe(true);

    // confidence 3,3 → avg 3 >= 2.5 → lowConfidence false
    const high = computeRevealStats(FIB, [vote('A', '5', 3), vote('B', '5', 3)]);
    expect(high.avgConfidence).toBe(3);
    expect(high.lowConfidence).toBe(false);
  });

  it('lowConfidence threshold documented as 2.5', () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(2.5);
  });

  it('custom deck ordering: S,S,L → median S; L is 2 positions away → outlier', () => {
    const deck = ['XS', 'S', 'M', 'L', 'XL'];
    const stats = computeRevealStats(deck, [
      vote('A', 'S', 3), vote('B', 'S', 3), vote('C', 'L', 3),
    ]);
    expect(stats.median).toBe('S');
    expect(stats.outliers).toEqual(['C']);
  });
});

describe('resolveDeck', () => {
  it('returns the spec deck for each named type', () => {
    expect(resolveDeck('fibonacci', null)[0]).toBe('1');
    expect(resolveDeck('tshirt', null)).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(resolveDeck('powers2', null)).toEqual(['1', '2', '4', '8', '16', '32', '64']);
    expect(resolveDeck('modFibonacci', null)[0]).toBe('0.5');
  });

  it('returns the customDeck array for deck=custom', () => {
    expect(resolveDeck('custom', ['A', 'B', 'C'])).toEqual(['A', 'B', 'C']);
    expect(resolveDeck('custom', null)).toEqual([]);
  });
});
