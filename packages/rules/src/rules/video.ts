import type { FeatureTrack, Observation, Rule, RuleContext, Severity } from '../types.js';

function forEachVideoTrack(
  ctx: RuleContext,
  fn: (t: FeatureTrack, connectionPid: string | null) => Observation | null
): Observation[] {
  const out: Observation[] = [];
  for (const c of ctx.connections) {
    for (const t of c.tracks) {
      if (t.kind !== 'video') continue;
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
  return { type, severity, category: 'video', pid, firstSeenAt: null, observation: data };
}

const freezes: Rule = {
  id: 'video.freezes',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.freezeCount || !t.totalFreezesDuration) return null;
    const totalMs = t.totalFreezesDuration;
    if (totalMs >= ctx.thresholds.freezeTotalCriticalMs) {
      return makeObservation('video.freezes', 'critical', pid, { count: t.freezeCount, totalFreezesDuration: totalMs });
    }
    if (totalMs >= ctx.thresholds.freezeTotalWarningMs) {
      return makeObservation('video.freezes', 'warning', pid, { count: t.freezeCount, totalFreezesDuration: totalMs });
    }
    return null;
  })
};

function qualityLimitationRule(id: string, field: 'cpuQualityLimitationPercentage' | 'bandwidthQualityLimitationPercentage'): Rule {
  return {
    id,
    category: 'video',
    scope: 'track',
    evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
      const pct = t[field];
      if (pct == null) return null;
      if (pct >= ctx.thresholds.qualityLimitationCriticalPct) {
        return makeObservation(id, 'critical', pid, { percentage: pct });
      }
      if (pct >= ctx.thresholds.qualityLimitationWarningPct) {
        return makeObservation(id, 'warning', pid, { percentage: pct });
      }
      return null;
    })
  };
}

const qualityLimitationCpu = qualityLimitationRule('video.quality_limitation_cpu', 'cpuQualityLimitationPercentage');
const qualityLimitationBandwidth = qualityLimitationRule('video.quality_limitation_bandwidth', 'bandwidthQualityLimitationPercentage');

const frequentResolutionChanges: Rule = {
  id: 'video.frequent_resolution_changes',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.qualityLimitationResolutionChanges == null) return null;
    if (t.qualityLimitationResolutionChanges < ctx.thresholds.resolutionChangesWarningCount) return null;
    return makeObservation('video.frequent_resolution_changes', 'warning', pid, {
      count: t.qualityLimitationResolutionChanges
    });
  })
};

const slowTimeToFirstFrame: Rule = {
  id: 'video.slow_time_to_first_frame',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.timeToFirstFrame == null) return null;
    if (t.timeToFirstFrame >= ctx.thresholds.ttffCriticalMs) {
      return makeObservation('video.slow_time_to_first_frame', 'critical', pid, { timeToFirstFrame: t.timeToFirstFrame });
    }
    if (t.timeToFirstFrame >= ctx.thresholds.ttffWarningMs) {
      return makeObservation('video.slow_time_to_first_frame', 'warning', pid, { timeToFirstFrame: t.timeToFirstFrame });
    }
    return null;
  })
};

const slowEncode: Rule = {
  id: 'video.slow_encode',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.direction !== 'sendonly' && t.direction !== 'sendrecv') return null;
    if (t.averageEncodeTime == null) return null;
    if (t.averageEncodeTime >= ctx.thresholds.encodeTimeCriticalMs) {
      return makeObservation('video.slow_encode', 'critical', pid, { averageEncodeTime: t.averageEncodeTime });
    }
    if (t.averageEncodeTime >= ctx.thresholds.encodeTimeWarningMs) {
      return makeObservation('video.slow_encode', 'warning', pid, { averageEncodeTime: t.averageEncodeTime });
    }
    return null;
  })
};

const slowDecode: Rule = {
  id: 'video.slow_decode',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (t.direction !== 'recvonly' && t.direction !== 'sendrecv') return null;
    if (t.averageDecodeTime == null) return null;
    if (t.averageDecodeTime >= ctx.thresholds.decodeTimeCriticalMs) {
      return makeObservation('video.slow_decode', 'critical', pid, { averageDecodeTime: t.averageDecodeTime });
    }
    if (t.averageDecodeTime >= ctx.thresholds.decodeTimeWarningMs) {
      return makeObservation('video.slow_decode', 'warning', pid, { averageDecodeTime: t.averageDecodeTime });
    }
    return null;
  })
};

const noHwAcceleration: Rule = {
  id: 'video.no_hw_acceleration',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.decoderImplementation || t.powerEfficientDecoder == null) return null;
    if (t.powerEfficientDecoder) return null;
    return makeObservation('video.no_hw_acceleration', 'info', pid, {
      decoderImplementation: t.decoderImplementation
    });
  })
};

const nullVideoDecoder: Rule = {
  id: 'video.null_video_decoder',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.hasNullVideoDecoder) return null;
    return makeObservation('video.null_video_decoder', 'critical', pid, {});
  })
};

const qpDegradation: Rule = {
  id: 'video.qp_degradation',
  category: 'video',
  scope: 'track',
  evaluate: (ctx) => forEachVideoTrack(ctx, (t, pid) => {
    if (!t.frameCount || t.qpSum == null) return null;
    const averageQp = t.qpSum / t.frameCount;
    if (averageQp >= ctx.thresholds.qpCritical) {
      return makeObservation('video.qp_degradation', 'critical', pid, { averageQp });
    }
    if (averageQp >= ctx.thresholds.qpWarning) {
      return makeObservation('video.qp_degradation', 'warning', pid, { averageQp });
    }
    return null;
  })
};

export const videoRules: Rule[] = [
  freezes,
  qualityLimitationCpu,
  qualityLimitationBandwidth,
  frequentResolutionChanges,
  slowTimeToFirstFrame,
  slowEncode,
  slowDecode,
  noHwAcceleration,
  nullVideoDecoder,
  qpDegradation
];
