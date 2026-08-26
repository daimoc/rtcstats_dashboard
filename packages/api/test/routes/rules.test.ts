import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';

describe('GET /api/rules', () => {
  it('returns every registered rule id and category', async () => {
    const app = buildApp({
      pool: {} as never,
      config: { passwordHash: hashPassword('x'), sessionSecret: 'test-secret' }
    });
    const response = await app.inject({ method: 'GET', url: '/api/rules' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string; category: string }>;
    expect(body.length).toBe(32);
    expect(body).toContainEqual({ id: 'video.freezes', category: 'video' });
  });
});
