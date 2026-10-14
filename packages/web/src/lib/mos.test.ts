import { describe, expect, it } from 'vitest';
import { formatMos, mosTone } from './mos.js';

describe('mosTone', () => {
  it('bands MOS by G.107 user satisfaction', () => {
    expect(mosTone(4.3)).toBe('ok');
    expect(mosTone(4)).toBe('ok');
    expect(mosTone(3.6)).toBe('warning');
    expect(mosTone(3.1)).toBe('warning');
    expect(mosTone(2.4)).toBe('critical');
  });

  it('marks a missing MOS as unknown', () => {
    expect(mosTone(null)).toBe('unknown');
    expect(mosTone(undefined)).toBe('unknown');
    expect(mosTone(Number.NaN)).toBe('unknown');
  });
});

describe('formatMos', () => {
  it('shows one decimal, or a dash when missing', () => {
    expect(formatMos(4.256)).toBe('4.3');
    expect(formatMos(null)).toBe('—');
  });
});
