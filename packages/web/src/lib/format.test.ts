import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration, formatElapsed, formatRelative, formatBytes } from './format.js';

describe('formatDuration', () => {
  it('renders a sub-hour duration as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(300)).toBe('5:00');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('renders an hour or more as h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('renders an em dash for a missing or negative duration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('formatDateTime', () => {
  const opts = { locale: 'en-US', timeZone: 'UTC' };

  it('renders a date and a 24-hour time', () => {
    expect(formatDateTime('2026-09-08T14:02:31Z', opts)).toBe('Sep 8, 2026, 14:02');
  });

  it('renders an em dash for a missing or unparseable value', () => {
    expect(formatDateTime(null, opts)).toBe('—');
    expect(formatDateTime('not-a-date', opts)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');

  it('describes recent times in seconds and minutes', () => {
    expect(formatRelative('2026-09-08T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-09-08T11:45:00Z', now)).toBe('15m ago');
  });

  it('describes older times in hours and days', () => {
    expect(formatRelative('2026-09-08T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelative('2026-09-05T12:00:00Z', now)).toBe('3d ago');
  });

  it('returns an empty string for a missing value', () => {
    expect(formatRelative(null, now)).toBe('');
  });
});

describe('formatBytes', () => {
  it('scales into a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('renders an em dash for a missing value', () => {
    expect(formatBytes(null)).toBe('—');
  });
});

describe('formatElapsed', () => {
  it('keeps millisecond precision for short spans', () => {
    expect(formatElapsed(0)).toBe('0 ms');
    expect(formatElapsed(420.4)).toBe('420 ms');
    expect(formatElapsed(4210)).toBe('4.2 s');
  });

  it('switches to m:ss from a minute', () => {
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(1_882_000)).toBe('31:22');
  });

  it('renders an em dash for a missing span', () => {
    expect(formatElapsed(null)).toBe('—');
    expect(formatElapsed(-5)).toBe('—');
  });
});
