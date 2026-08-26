import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyze.js';
import { getRuleIds } from '../src/registry.js';
import { defaultThresholds } from '../src/thresholds.js';
import type { Rule, RuleContext } from '../src/types.js';

const emptyCtx: RuleContext = {
  metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 0 },
  client: null,
  connections: [],
  thresholds: defaultThresholds
};

const ctxWithConnection: RuleContext = {
  ...emptyCtx,
  connections: [{
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: true,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: []
  }]
};

const fakeFiringRule: Rule = {
  id: 'fake.always_fires',
  category: 'connectivity',
  scope: 'session',
  evaluate: () => [{
    type: 'fake.always_fires', severity: 'warning', category: 'connectivity',
    pid: null, firstSeenAt: 0, observation: {}
  }]
};

const fakeSilentRule: Rule = {
  id: 'fake.never_fires',
  category: 'video',
  scope: 'session',
  evaluate: () => []
};

describe('analyze', () => {
  it('returns insufficient_data with no scores when there are no connections', () => {
    const result = analyze(emptyCtx, [fakeFiringRule]);
    expect(result.status).toBe('insufficient_data');
    expect(result.scores).toBeNull();
    expect(result.observations).toEqual([]);
  });

  it('runs every rule and returns ok when at least one connection exists', () => {
    const result = analyze(ctxWithConnection, [fakeFiringRule, fakeSilentRule]);
    expect(result.status).toBe('ok');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].type).toBe('fake.always_fires');
    expect(result.scores?.connectivity).toBeLessThan(100);
  });
});

describe('getRuleIds', () => {
  it('lists the id of every rule in a registry', () => {
    expect(getRuleIds([fakeFiringRule, fakeSilentRule])).toEqual([
      'fake.always_fires',
      'fake.never_fires'
    ]);
  });
});
