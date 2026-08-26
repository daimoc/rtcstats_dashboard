import { describe, it, expect } from 'vitest';
import { apiRules } from '../../src/rules/api.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureConnection, RuleContext } from '../../src/types.js';

function baseConnection(overrides: Partial<FeatureConnection> = {}): FeatureConnection {
  return {
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: [],
    ...overrides
  };
}

function ctxWith(connection: FeatureConnection): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client: null,
    connections: [connection],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = apiRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('api.add_ice_candidate_failure', () => {
  it('fires warning when addIceCandidate failed', () => {
    const ctx = ctxWith(baseConnection({ addIceCandidateFailure: 'OperationError: ...' }));
    const [obs] = ruleById('api.add_ice_candidate_failure').evaluate(ctx);
    expect(obs.severity).toBe('warning');
    expect(obs.observation.error).toBe('OperationError: ...');
  });

  it('does not fire when null', () => {
    expect(ruleById('api.add_ice_candidate_failure').evaluate(ctxWith(baseConnection()))).toHaveLength(0);
  });
});

describe('api.set_local_description_failure', () => {
  it('fires critical when setLocalDescription failed', () => {
    const ctx = ctxWith(baseConnection({ setLocalDescriptionFailure: 'InvalidStateError' }));
    const [obs] = ruleById('api.set_local_description_failure').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('api.set_remote_description_failure', () => {
  it('fires critical when setRemoteDescription failed', () => {
    const ctx = ctxWith(baseConnection({ setRemoteDescriptionFailure: 'InvalidAccessError' }));
    const [obs] = ruleById('api.set_remote_description_failure').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});
