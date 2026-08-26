import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';

function testApp(query: () => Promise<unknown>) {
  return buildApp({
    pool: { query } as never,
    config: { passwordHash: hashPassword('x'), sessionSecret: 'test-secret' }
  });
}

describe('GET /api/health', () => {
  it('returns ok when the database responds', async () => {
    const app = testApp(async () => ({ rows: [{ ok: 1 }] }));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    const app = testApp(async () => { throw new Error('connection refused'); });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe('error');
  });
});
