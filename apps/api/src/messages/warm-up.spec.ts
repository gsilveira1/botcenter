import { describe, expect, it } from 'vitest';
import { bucketLimits, warmUpFactor } from './warm-up';

const DAY = 86_400_000;
const config = { days: 7, startPercent: 20 };
const first = new Date('2026-10-01T12:00:00Z');
const at = (days: number) => new Date(first.getTime() + days * DAY);

describe('warmUpFactor', () => {
  it('grows linearly from 20 % on day 0 to 100 % on day 6', () => {
    const factors = [0, 1, 2, 3, 4, 5, 6, 30].map((day) =>
      Math.round(warmUpFactor(first, at(day), config) * 100),
    );
    expect(factors).toEqual([20, 33, 47, 60, 73, 87, 100, 100]);
  });

  it('counts whole days from the first connection', () => {
    expect(warmUpFactor(first, at(0.99), config)).toBeCloseTo(0.2);
    expect(warmUpFactor(first, at(1), config)).toBeGreaterThan(0.33);
  });

  it('gives the day 0 rate to an instance without a first connection', () => {
    expect(warmUpFactor(null, at(10), config)).toBeCloseTo(0.2);
  });

  it('is off with 0 or 1 day, or a start of 100 %', () => {
    expect(warmUpFactor(first, first, { days: 0, startPercent: 20 })).toBe(1);
    expect(warmUpFactor(first, first, { days: 1, startPercent: 20 })).toBe(1);
    expect(warmUpFactor(first, first, { days: 7, startPercent: 100 })).toBe(1);
  });
});

describe('bucketLimits', () => {
  it('applies the factor to the rate and keeps the burst small', () => {
    expect(bucketLimits(20, 3, 0.2)).toEqual({ ratePerMinute: 4, burst: 3 });
    expect(bucketLimits(20, 3, 1)).toEqual({ ratePerMinute: 20, burst: 3 });
    expect(bucketLimits(2, 3, 1)).toEqual({ ratePerMinute: 2, burst: 2 });
  });

  it('keeps at least one send for each minute', () => {
    expect(bucketLimits(2, 3, 0.2)).toEqual({ ratePerMinute: 1, burst: 1 });
  });
});
