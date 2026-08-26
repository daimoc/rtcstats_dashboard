import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';

function testApp() {
  return buildApp({
    pool: {} as never,
    config: { passwordHash: hashPassword('correct-password'), sessionSecret: 'test-secret' }
  });
}

describe('POST /api/login', () => {
  it('sets a session cookie on a correct password', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct-password' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('rejects an incorrect password', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
    expect(response.statusCode).toBe(401);
  });

  it('rate-limits repeated failed attempts from the same IP', async () => {
    const app = testApp();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
    }
    expect(last!.statusCode).toBe(429);
  });
});

describe('GET /api/me', () => {
  it('reports authenticated after login', async () => {
    const app = testApp();
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct-password' } });
    const cookie = login.headers['set-cookie'];
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie! } });
    expect(me.json()).toEqual({ authenticated: true });
  });

  it('reports unauthenticated with no cookie', async () => {
    const app = testApp();
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    expect(me.json()).toEqual({ authenticated: false });
  });
});

describe('POST /api/logout', () => {
  it('clears the session cookie', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'POST', url: '/api/logout' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('dashboard_session=;');
  });
});
