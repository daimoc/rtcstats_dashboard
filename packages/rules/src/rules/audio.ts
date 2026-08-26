import type { FeatureTrack, Observation, Rule, RuleContext, Severity } from '../types.js';

function forEachAudioTrack(
  ctx: RuleContext,
  fn: (t: FeatureTrack, connectionPid: string | null) => Observation | null
): Observation[] {
  const out: Observation[] = [];
  for (const c of ctx.connections) {
    for (const t of c.tracks) {
      if (t.kind !== 'audio') continue;
      const obs = fn(t, c.connectionIdentifier);
      if (obs) out.push(obs);
    }
  }
  return out;
}

function makeObservation(
  type: string,
  severity: Severity,
  pid: string | null,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'audio', pid, firstSeenAt: null, observation: data };
}

const concealmentRatio: Rule = {
  id: 'audio.concealment_ratio',
  category: 'audio',
  scope: 'track',
  evaluate: (ctx) => forEachAudioTrack(ctx, (t, pid) => {
    if (t.concealmentPercentage == null) return null;
    if (t.concealmentPercentage >= ctx.thresholds.concealmentCriticalPct) {
      return makeObservation('audio.concealment_ratio', 'critical', pid, { percentage: t.concealmentPercentage });
    }
    if (t.concealmentPercentage >= ctx.thresholds.concealmentWarningPct) {
      return makeObservation('audio.concealment_ratio', 'warning', pid, { percentage: t.concealmentPercentage });
    }
    return null;
  })
};

const jitterBufferFlushes: Rule = {
  id: 'audio.jitter_buffer_flushes',
  category: 'audio',
  scope: 'track',
  evaluate: (ctx) => forEachAudioTrack(ctx, (t, pid) => {
    if (t.hasPeriodicJitterBufferFlushes) {
      return makeObservation('audio.jitter_buffer_flushes', 'critical', pid, { periodic: true, count: t.jitterBufferFlushes ?? 0 });
    }
    if (t.jitterBufferFlushes != null && t.jitterBufferFlushes >= ctx.thresholds.jitterBufferFlushesWarningCount) {
      return makeObservation('audio.jitter_buffer_flushes', 'warning', pid, { periodic: false, count: t.jitterBufferFlushes });
    }
    return null;
  })
};

const timeStretching: Rule = {
  id: 'audio.time_stretching',
  category: 'audio',
  scope: 'track',
  evaluate: (ctx) => forEachAudioTrack(ctx, (t, pid) => {
    const worst = Math.max(t.decelerationPercentage ?? 0, t.accelerationPercentage ?? 0);
    if (worst >= ctx.thresholds.timeStretchingCriticalPct) {
      return makeObservation('audio.time_stretching', 'critical', pid, { percentage: worst });
    }
    if (worst >= ctx.thresholds.timeStretchingWarningPct) {
      return makeObservation('audio.time_stretching', 'warning', pid, { percentage: worst });
    }
    return null;
  })
};

const trackEndedUnexpectedly: Rule = {
  id: 'audio.track_ended_unexpectedly',
  category: 'audio',
  scope: 'session',
  evaluate: (ctx) => {
    if (!ctx.client) return [];
    if (ctx.client.audioEnded && ctx.client.audioShortDuration) {
      return [makeObservation('audio.track_ended_unexpectedly', 'warning', null, {})];
    }
    return [];
  }
};

export const audioRules: Rule[] = [
  concealmentRatio,
  jitterBufferFlushes,
  timeStretching,
  trackEndedUnexpectedly
];
