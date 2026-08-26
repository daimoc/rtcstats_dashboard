import type { Observation, Rule, Severity } from '../types.js';

function makeObservation(
  type: string,
  severity: Severity,
  data: Record<string, unknown>
): Observation {
  return { type, severity, category: 'device', pid: null, firstSeenAt: null, observation: data };
}

const getUserMediaFailure: Rule = {
  id: 'device.get_user_media_failure',
  category: 'device',
  scope: 'session',
  evaluate: (ctx) => {
    const c = ctx.client;
    if (!c || !c.getUserMediaErrorCount) return [];
    const severity: Severity = c.getUserMediaSuccessCount ? 'warning' : 'critical';
    return [makeObservation('device.get_user_media_failure', severity, {
      successCount: c.getUserMediaSuccessCount,
      errorCount: c.getUserMediaErrorCount,
      error: c.getUserMediaError
    })];
  }
};

const lowCpuPerformance: Rule = {
  id: 'device.low_cpu_performance',
  category: 'device',
  scope: 'session',
  evaluate: (ctx) => {
    const c = ctx.client;
    if (!c || c.cpuPerformance == null) return [];
    if (c.cpuPerformance > ctx.thresholds.lowCpuPerformanceThreshold) return [];
    return [makeObservation('device.low_cpu_performance', 'warning', { cpuPerformance: c.cpuPerformance })];
  }
};

const frequentReloads: Rule = {
  id: 'device.frequent_reloads',
  category: 'device',
  scope: 'session',
  evaluate: (ctx) => {
    const c = ctx.client;
    if (!c || c.reloadCount == null) return [];
    if (c.reloadCount < ctx.thresholds.reloadCountWarningCount) return [];
    return [makeObservation('device.frequent_reloads', 'warning', { reloadCount: c.reloadCount })];
  }
};

export const deviceRules: Rule[] = [getUserMediaFailure, lowCpuPerformance, frequentReloads];
