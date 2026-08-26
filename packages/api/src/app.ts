import type { S3Client } from '@aws-sdk/client-s3';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type pg from 'pg';
import { LoginRateLimiter } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoute } from './routes/health.js';
import { registerRulesRoute } from './routes/rules.js';
import { registerDumpProxyRoute, registerSessionDetailRoute, registerSessionsRoute } from './routes/sessions.js';

export interface AppConfig {
  passwordHash: string;
  sessionSecret: string;
}

export interface AppDeps {
  pool: pg.Pool;
  config: AppConfig;
  checkS3?: () => Promise<void>;
  s3?: { client: S3Client; bucket: string };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);

  const rateLimiter = new LoginRateLimiter({ maxAttempts: 10, windowMs: 15 * 60 * 1000 });
  registerAuthRoutes(app, deps.config, rateLimiter);
  registerHealthRoute(app, deps.pool, deps.checkS3);
  registerRulesRoute(app);
  registerSessionsRoute(app, deps.pool, deps.config.sessionSecret);
  registerSessionDetailRoute(app, deps.pool, deps.s3, deps.config.sessionSecret);
  registerDumpProxyRoute(app, deps.pool, deps.s3, deps.config.sessionSecret);

  return app;
}
