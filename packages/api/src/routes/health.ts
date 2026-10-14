import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export function registerHealthRoute(app: FastifyInstance, pool: pg.Pool, checkS3?: () => Promise<void>, prefix: string = '/api'): void {
  app.get(prefix + '/health', async (_request, reply) => {
    try {
      await pool.query('select 1');
      if (checkS3) await checkS3();
      reply.send({ status: 'ok' });
    } catch (err) {
      reply.code(503).send({ status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
