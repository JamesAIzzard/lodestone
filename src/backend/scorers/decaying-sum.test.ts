import { describe, it, expect } from 'vitest';
import { decayingSum, summariseDecay, DEFAULT_DAMPING } from '../../shared/portable/decaying-sum';

describe('decayingSum', () => {
  it('returns 0 for empty input', () => {
    expect(decayingSum([])).toBe(0);
  });

  it('returns the score for a single element', () => {
    expect(decayingSum([0.85])).toBeCloseTo(0.85);
  });

  it('returns 1.0 for a single perfect score', () => {
    expect(decayingSum([1.0])).toBe(1);
  });

  it('barely changes when one signal dominates', () => {
    // [0.90, 0.10, 0.05] → 0.90 + 0.025 + 0.003125 = 0.928
    const result = decayingSum([0.90, 0.10, 0.05]);
    expect(result).toBeCloseTo(0.928, 2);
  });

  it('provides meaningful lift for multiple moderate signals', () => {
    // [0.60, 0.55, 0.50, 0.45]
    // = 0.60 + 0.25*0.55 + 0.0625*0.50 + 0.015625*0.45
    // = 0.60 + 0.1375 + 0.03125 + 0.00703125 = 0.7758
    const result = decayingSum([0.60, 0.55, 0.50, 0.45]);
    expect(result).toBeCloseTo(0.776, 2);
  });

  it('sorts input descending regardless of input order', () => {
    const a = decayingSum([0.45, 0.60, 0.50, 0.55]);
    const b = decayingSum([0.60, 0.55, 0.50, 0.45]);
    expect(a).toBeCloseTo(b, 10);
  });

  it('clamps to 1.0', () => {
    // Multiple perfect scores would exceed 1.0 without clamping
    const result = decayingSum([1.0, 1.0, 1.0]);
    expect(result).toBe(1);
  });

  it('respects custom damping factor', () => {
    // d=0.5: 0.8 + 0.5*0.6 = 0.8 + 0.3 = 1.0 (clamped)
    expect(decayingSum([0.8, 0.6], 0.5)).toBe(1.0);
    // d=0.1: 0.8 + 0.1*0.6 = 0.8 + 0.06 = 0.86
    expect(decayingSum([0.8, 0.6], 0.1)).toBeCloseTo(0.86);
  });
});

describe('summariseDecay', () => {
  it('returns "none" for empty input', () => {
    const result = summariseDecay({});
    expect(result.label).toBe('none');
    expect(result.score).toBe(0);
    expect(result.breakdown).toEqual([]);
  });

  it('returns signal name when single signal present', () => {
    const result = summariseDecay({ semantic: 0.85 });
    expect(result.label).toBe('semantic');
    expect(result.score).toBeCloseTo(0.85);
    expect(result.breakdown).toEqual([['semantic', 0.85]]);
  });

  it('returns dominant signal name when one signal overwhelms', () => {
    const result = summariseDecay({ semantic: 0.90, bm25: 0.05 });
    // score ≈ 0.90 + 0.25*0.05 = 0.9125, bonus = 0.0125 < 0.02 threshold
    expect(result.label).toBe('semantic');
  });

  it('returns "convergence" when multiple signals contribute meaningfully', () => {
    const result = summariseDecay({ semantic: 0.60, bm25: 0.55, filepath: 0.50 });
    expect(result.label).toBe('convergence');
    // score = 0.60 + 0.25*0.55 + 0.0625*0.50 = 0.60 + 0.1375 + 0.03125 = 0.769
    expect(result.score).toBeCloseTo(0.769, 2);
  });

  it('sorts breakdown entries by score descending', () => {
    const result = summariseDecay({ bm25: 0.55, filepath: 0.50, semantic: 0.60 });
    expect(result.breakdown[0][0]).toBe('semantic');
    expect(result.breakdown[1][0]).toBe('bm25');
    expect(result.breakdown[2][0]).toBe('filepath');
  });

  it('filters out zero-score signals', () => {
    const result = summariseDecay({ semantic: 0.80, bm25: 0, filepath: 0 });
    expect(result.breakdown.length).toBe(1);
    expect(result.label).toBe('semantic');
  });

  it('respects custom damping factor', () => {
    const result = summariseDecay({ semantic: 0.60, bm25: 0.55 }, 0.5);
    // score = 0.60 + 0.5*0.55 = 0.875, bonus = 0.275 → convergence
    expect(result.label).toBe('convergence');
    expect(result.score).toBeCloseTo(0.875);
  });
});
