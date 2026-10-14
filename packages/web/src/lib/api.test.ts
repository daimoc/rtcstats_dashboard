import { describe, expect, it } from 'vitest';
import { listSessionsUrl, type SessionFilters } from './api.js';

function filters(overrides: Partial<SessionFilters> = {}): SessionFilters {
  return { sort: 'date', limit: 25, ...overrides };
}

describe('listSessionsUrl', () => {
  it('carries a free-text query through as q', () => {
    const url = listSessionsUrl(filters({ q: 'alice' }));
    expect(new URL(url, 'http://x').searchParams.get('q')).toBe('alice');
  });

  it('percent-encodes a query containing wildcard characters', () => {
    const url = listSessionsUrl(filters({ q: '100% loss' }));
    expect(url).toContain('q=100%25+loss');
    expect(new URL(url, 'http://x').searchParams.get('q')).toBe('100% loss');
  });

  it('carries the MOS filter through as maxMos', () => {
    const url = listSessionsUrl(filters({ maxMos: 3.5 }));
    expect(new URL(url, 'http://x').searchParams.get('maxMos')).toBe('3.5');
    expect(listSessionsUrl(filters())).not.toContain('maxMos');
  });

  it('omits q when it is empty or absent', () => {
    expect(listSessionsUrl(filters())).not.toContain('q=');
    expect(listSessionsUrl(filters({ q: '' }))).not.toContain('q=');
  });

  it('keeps the date range, sort and pagination params alongside q', () => {
    const url = listSessionsUrl(filters({ q: 'bob', from: '2026-09-07T12:00:00.000Z', sort: 'score', cursor: 'abc' }));
    const params = new URL(url, 'http://x').searchParams;
    expect(params.get('q')).toBe('bob');
    expect(params.get('from')).toBe('2026-09-07T12:00:00.000Z');
    expect(params.get('sort')).toBe('score');
    expect(params.get('cursor')).toBe('abc');
    expect(params.get('limit')).toBe('25');
  });
});
