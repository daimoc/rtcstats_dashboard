import { describe, expect, it } from 'vitest';
import { RANGE_PRESETS, isRangeId, presetFrom, toLocalInputValue } from './dateRange.js';

const NOW = Date.parse('2026-09-08T12:00:00Z');

describe('presetFrom', () => {
  it('converts each fixed-window preset into an ISO lower bound', () => {
    expect(presetFrom('24h', NOW)).toBe('2026-09-07T12:00:00.000Z');
    expect(presetFrom('7d', NOW)).toBe('2026-09-01T12:00:00.000Z');
    expect(presetFrom('30d', NOW)).toBe('2026-08-09T12:00:00.000Z');
  });

  it('returns undefined for ranges that have no lower bound', () => {
    expect(presetFrom('all', NOW)).toBeUndefined();
    expect(presetFrom('custom', NOW)).toBeUndefined();
  });
});

describe('RANGE_PRESETS', () => {
  it('lists the selectable chips in order, ending with all time', () => {
    expect(RANGE_PRESETS.map((p) => p.id)).toEqual(['24h', '7d', '30d', 'all']);
    expect(RANGE_PRESETS.every((p) => p.label.length > 0)).toBe(true);
  });
});

describe('isRangeId', () => {
  it('accepts known ids and rejects anything else', () => {
    expect(isRangeId('24h')).toBe(true);
    expect(isRangeId('custom')).toBe(true);
    expect(isRangeId('all')).toBe(true);
    expect(isRangeId('90d')).toBe(false);
    expect(isRangeId(null)).toBe(false);
  });
});

describe('toLocalInputValue', () => {
  it('formats an ISO instant for a datetime-local input', () => {
    expect(toLocalInputValue('2026-09-08T14:02:31Z', 'UTC')).toBe('2026-09-08T14:02');
  });

  it('returns an empty string for a missing or unparseable value', () => {
    expect(toLocalInputValue(undefined, 'UTC')).toBe('');
    expect(toLocalInputValue('nope', 'UTC')).toBe('');
  });
});
