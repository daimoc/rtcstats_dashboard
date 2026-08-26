import { score } from './scoring.js';
import type { AnalysisResult, Rule, RuleContext } from './types.js';

export function analyze(ctx: RuleContext, rules: Rule[]): AnalysisResult {
  if (ctx.connections.length === 0) {
    return { status: 'insufficient_data', scores: null, observations: [] };
  }

  const observations = rules.flatMap((rule) => rule.evaluate(ctx));
  const scores = score(observations, ctx);

  return { status: 'ok', scores, observations };
}
