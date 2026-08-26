import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'dashboard_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function createSessionToken(secret: string, now = Date.now()): string {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ expiresAt })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): boolean {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expectedSignature = createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) return false;

  try {
    const { expiresAt } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof expiresAt === 'number' && expiresAt > now;
  } catch {
    return false;
  }
}

export interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
}

export class LoginRateLimiter {
  private attempts = new Map<string, number[]>();

  constructor(private options: RateLimiterOptions) {}

  registerAttempt(ip: string, now = Date.now()): void {
    const timestamps = (this.attempts.get(ip) ?? []).filter((t) => now - t < this.options.windowMs);
    timestamps.push(now);
    this.attempts.set(ip, timestamps);
  }

  isBlocked(ip: string, now = Date.now()): boolean {
    const timestamps = (this.attempts.get(ip) ?? []).filter((t) => now - t < this.options.windowMs);
    return timestamps.length >= this.options.maxAttempts;
  }
}

export function requireAuth(sessionSecret: string) {
  return async (
    request: { cookies: Record<string, string | undefined> },
    reply: { code: (n: number) => { send: (body: unknown) => void } }
  ) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token || !verifySessionToken(token, sessionSecret)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
