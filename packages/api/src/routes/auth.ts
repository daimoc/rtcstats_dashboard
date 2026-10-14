import type { FastifyInstance } from 'fastify';
import { LoginRateLimiter, SESSION_COOKIE_NAME, createSessionToken, verifyPassword, verifySessionToken } from '../auth.js';
import type { AppConfig } from '../app.js';

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, rateLimiter: LoginRateLimiter, prefix: string): void {
  app.post<{ Body: { password?: string } }>(prefix + '/login', async (request, reply) => {
    const ip = request.ip;
    if (rateLimiter.isBlocked(ip)) {
      reply.code(429).send({ error: 'too_many_attempts' });
      return;
    }
    rateLimiter.registerAttempt(ip);

    const { password } = request.body ?? {};
    if (!password || !verifyPassword(password, config.passwordHash)) {
      reply.code(401).send({ error: 'invalid_password' });
      return;
    }

    const token = createSessionToken(config.sessionSecret);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60
    });
    reply.send({ authenticated: true });
  });

  app.post(prefix + '/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    reply.send({ authenticated: false });
  });

  app.get(prefix + '/me', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const authenticated = !!token && verifySessionToken(token, config.sessionSecret);
    reply.send({ authenticated });
  });
}
