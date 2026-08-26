import { describe, it, expect } from 'vitest';
import { deviceRules } from '../../src/rules/device.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureClient, RuleContext } from '../../src/types.js';

function baseClient(overrides: Partial<FeatureClient> = {}): FeatureClient {
  return {
    id: 1, dumpId: 1, hardwareConcurrency: 8, deviceMemory: 8,
    calledGetUserMedia: true, getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0, getUserMediaError: null,
    reloadCount: 0, cpuPerformance: 5, operatingSystem: 'macOS',
    audioEnded: false, audioShortDuration: false, videoEnded: false, videoShortDuration: false,
    ...overrides
  };
}

function ctxWith(client: FeatureClient | null): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client,
    connections: [{
      id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
      iceConnected: true, iceConnectionTime: 500, iceRestart: false,
      addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
      connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
      firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
      averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
      signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
      clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
      tracks: []
    }],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = deviceRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('device.get_user_media_failure', () => {
  it('fires critical when every getUserMedia call failed', () => {
    const ctx = ctxWith(baseClient({ getUserMediaSuccessCount: 0, getUserMediaErrorCount: 2, getUserMediaError: 'NotAllowedError' }));
    const [obs] = ruleById('device.get_user_media_failure').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.observation.error).toBe('NotAllowedError');
  });

  it('fires warning when some calls succeeded and some failed', () => {
    const ctx = ctxWith(baseClient({ getUserMediaSuccessCount: 1, getUserMediaErrorCount: 1 }));
    const [obs] = ruleById('device.get_user_media_failure').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire with no failures', () => {
    const ctx = ctxWith(baseClient({ getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0 }));
    expect(ruleById('device.get_user_media_failure').evaluate(ctx)).toHaveLength(0);
  });

  it('does not fire when there is no client row', () => {
    expect(ruleById('device.get_user_media_failure').evaluate(ctxWith(null))).toHaveLength(0);
  });
});

describe('device.low_cpu_performance', () => {
  it('fires warning at or below the threshold', () => {
    const ctx = ctxWith(baseClient({ cpuPerformance: 2 }));
    const [obs] = ruleById('device.low_cpu_performance').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire above the threshold', () => {
    const ctx = ctxWith(baseClient({ cpuPerformance: 5 }));
    expect(ruleById('device.low_cpu_performance').evaluate(ctx)).toHaveLength(0);
  });
});

describe('device.frequent_reloads', () => {
  it('fires warning above the warning count', () => {
    const ctx = ctxWith(baseClient({ reloadCount: 3 }));
    const [obs] = ruleById('device.frequent_reloads').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire for zero reloads', () => {
    const ctx = ctxWith(baseClient({ reloadCount: 0 }));
    expect(ruleById('device.frequent_reloads').evaluate(ctx)).toHaveLength(0);
  });
});
