import type { FastifyInstance } from 'fastify';
import { buildRegistry } from '@rtcstats-dashboard/rules';

export function registerRulesRoute(app: FastifyInstance, prefix: string): void {
  app.get(prefix + '/rules', async (_request, reply) => {
    const catalog = buildRegistry().map((rule) => ({ id: rule.id, category: rule.category }));
    reply.send(catalog);
  });
}
