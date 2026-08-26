import { describe, expect, it } from 'vitest';
import { LoginRateLimiter, createSessionToken, hashPassword, verifyPassword, verifySessionToken } from '../src/auth.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies a matching password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces a different hash each time (random salt)', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });
});

describe('createSessionToken / verifySessionToken', () => {
  it('verifies a freshly created token', () => {
    const token = createSessionToken('secret');
    expect(verifySessionToken(token, 'secret')).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken('secret-a');
    expect(verifySessionToken(token, 'secret-b')).toBe(false);
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const token = createSessionToken('secret', now - 8 * 24 * 60 * 60 * 1000);
    expect(verifySessionToken(token, 'secret', now)).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifySessionToken('not-a-real-token', 'secret')).toBe(false);
  });
});

describe('LoginRateLimiter', () => {
  it('blocks after the configured number of attempts within the window', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 1000 });
    const now = Date.now();
    limiter.registerAttempt('1.2.3.4', now);
    limiter.registerAttempt('1.2.3.4', now);
    limiter.registerAttempt('1.2.3.4', now);
    expect(limiter.isBlocked('1.2.3.4', now)).toBe(true);
  });

  it('does not block a different IP', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000 });
    const now = Date.now();
    limiter.registerAttempt('1.2.3.4', now);
    expect(limiter.isBlocked('5.6.7.8', now)).toBe(false);
  });

  it('forgets attempts once the window has passed', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000 });
    const now = Date.now();
    limiter.registerAttempt('1.2.3.4', now);
    expect(limiter.isBlocked('1.2.3.4', now + 2000)).toBe(false);
  });
});
