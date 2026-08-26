import { describe, it, expect } from 'vitest';
import { clamp } from '../src/util.js';

describe('clamp', () => {
  it('returns the value when within range', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('clamps to the minimum', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('clamps to the maximum', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
});