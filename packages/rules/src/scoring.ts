import { clamp } from './util.js';
import type { Category, Observation, RuleContext, Scores, Severity } from './types.js';

function severityWeight(severity: Severity): number {
  if (severity === 'critical') return 1;
  if (severity === 'warning') return 0.4;
  return 0.1;
}

function deductionFor(observations: Observation[], category: Category, weights: Record<string, number>): number {
  return observations
    .filter((o) => o.category === category)
    .reduce((sum, o) => sum + severityWeight(o.severity) * (weights[o.type] ?? 10), 0);
}

export function score(observations: Observation[], ctx: RuleContext): Scores {
  const { weights } = ctx.thresholds;
  const hasConnections = ctx.connections.length > 0;
  const hasAudioTrack = ctx.connections.some((c) => c.tracks.some((t) => t.kind === 'audio'));
  const hasVideoTrack = ctx.connections.some((c) => c.tracks.some((t) => t.kind === 'video'));

  const connectivity = hasConnections
    ? clamp(100 - deductionFor(observations, 'connectivity', weights), 0, 100)
    : null;
  const audio = hasAudioTrack
    ? clamp(100 - deductionFor(observations, 'audio', weights), 0, 100)
    : null;
  const video = hasVideoTrack
    ? clamp(100 - deductionFor(observations, 'video', weights), 0, 100)
    : null;

  const applicable = [connectivity, audio, video].filter((s): s is number => s !== null);
  const base = applicable.length > 0
    ? applicable.reduce((a, b) => a + b, 0) / applicable.length
    : 100;

  const modifierDeduction =
    deductionFor(observations, 'device', weights) + deductionFor(observations, 'api', weights);

  const experience = clamp(base - modifierDeduction, 0, 100);

  return { connectivity, audio, video, experience };
}
