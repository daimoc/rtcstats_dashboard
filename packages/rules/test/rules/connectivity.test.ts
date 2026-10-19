import { describe, it, expect } from 'vitest';
import { connectivityRules } from '../../src/rules/connectivity.js';
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

function ctxWith(connections: FeatureConnection[]): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: connections.length },
    client: null,
    connections,
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = connectivityRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('connectivity.never_connected', () => {
  it('fires critical when a connection never connected', () => {
    const ctx = ctxWith([baseConnection({ connected: false })]);
    const [obs] = ruleById('connectivity.never_connected').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.pid).toBe('PC_0');
  });

  it('does not fire when connected', () => {
    const ctx = ctxWith([baseConnection({ connected: true })]);
    expect(ruleById('connectivity.never_connected').evaluate(ctx)).toHaveLength(0);
  });

  it('does not fire for a connection closed before any session description was applied', () => {
    // LiveKit opens a throwaway connection, creates an offer it never applies, and closes
    // it within milliseconds: it never tried to connect, so it cannot have failed to.
    const ctx = ctxWith([baseConnection({
      connected: false, iceConnected: false, setLocalDescriptionRole: null, setRemoteDescriptionRole: null
    })]);
    expect(ruleById('connectivity.never_connected').evaluate(ctx)).toHaveLength(0);
  });

  it('still fires when an offer was applied but the connection never came up', () => {
    // Offer sent, answer never received: a real signaling/connectivity failure.
    const ctx = ctxWith([baseConnection({
      connected: false, setLocalDescriptionRole: 'offer', setRemoteDescriptionRole: null
    })]);
    expect(ruleById('connectivity.never_connected').evaluate(ctx)).toHaveLength(1);
  });

  it('keeps firing when the description roles were not extracted at all', () => {
    const ctx = ctxWith([baseConnection({ connected: false, setLocalDescriptionRole: undefined })]);
    expect(ruleById('connectivity.never_connected').evaluate(ctx)).toHaveLength(1);
  });

  it('does not fire when connected is unknown (null)', () => {
    const ctx = ctxWith([baseConnection({ connected: null })]);
    expect(ruleById('connectivity.never_connected').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.slow_ice_connect', () => {
  it('does not fire under the warning threshold', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: 3999 })]);
    expect(ruleById('connectivity.slow_ice_connect').evaluate(ctx)).toHaveLength(0);
  });

  it('fires warning between warning and critical thresholds', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: 4500 })]);
    const [obs] = ruleById('connectivity.slow_ice_connect').evaluate(ctx);
    expect(obs.severity).toBe('warning');
    expect(obs.observation.iceConnectionTime).toBe(4500);
  });

  it('fires critical above the critical threshold', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: 9000 })]);
    const [obs] = ruleById('connectivity.slow_ice_connect').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire when ice connection time is missing', () => {
    const ctx = ctxWith([baseConnection({ iceConnectionTime: null })]);
    expect(ruleById('connectivity.slow_ice_connect').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.slow_turn_gathering', () => {
  it('fires on the slowest of the three TURN gathering times', () => {
    const ctx = ctxWith([baseConnection({ gatheringTimeTurnUdp: 1000, gatheringTimeTurnTcp: 6000, gatheringTimeTurnTls: null })]);
    const [obs] = ruleById('connectivity.slow_turn_gathering').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire when no TURN gathering times are present', () => {
    const ctx = ctxWith([baseConnection()]);
    expect(ruleById('connectivity.slow_turn_gathering').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.ice_restart', () => {
  it('fires warning on an ICE restart', () => {
    const ctx = ctxWith([baseConnection({ iceRestart: true })]);
    const [obs] = ruleById('connectivity.ice_restart').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('connectivity.ice_restart_followed_by_srd', () => {
  it('fires critical when an ICE restart raced a setRemoteDescription', () => {
    const ctx = ctxWith([baseConnection({ iceRestartFollowedBySetRemoteDescription: true })]);
    const [obs] = ruleById('connectivity.ice_restart_followed_by_srd').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('connectivity.null_candidate_added', () => {
  it('fires info when a null (end-of-candidates) candidate was added', () => {
    const ctx = ctxWith([baseConnection({ addedNullCandidate: true })]);
    const [obs] = ruleById('connectivity.null_candidate_added').evaluate(ctx);
    expect(obs.severity).toBe('info');
  });
});

describe('connectivity.relay_only_path', () => {
  it('fires warning when the first candidate pair used a relay', () => {
    const ctx = ctxWith([baseConnection({ firstCandidatePairLocalType: 'relay' })]);
    const [obs] = ruleById('connectivity.relay_only_path').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire for a host candidate pair', () => {
    const ctx = ctxWith([baseConnection({ firstCandidatePairLocalType: 'host' })]);
    expect(ruleById('connectivity.relay_only_path').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.dtls_handshake_incomplete', () => {
  it('fires warning when connected but no DTLS version was recorded', () => {
    const ctx = ctxWith([baseConnection({ connected: true, dtlsVersion: null })]);
    const [obs] = ruleById('connectivity.dtls_handshake_incomplete').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire when not connected', () => {
    const ctx = ctxWith([baseConnection({ connected: false, dtlsVersion: null })]);
    expect(ruleById('connectivity.dtls_handshake_incomplete').evaluate(ctx)).toHaveLength(0);
  });
});

describe('connectivity.clock_skew', () => {
  it('fires critical above the critical threshold in either direction', () => {
    const ctx = ctxWith([baseConnection({ clockSkew: -1500 })]);
    const [obs] = ruleById('connectivity.clock_skew').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('connectivity.signaling_delay', () => {
  it('fires warning above the warning threshold', () => {
    const ctx = ctxWith([baseConnection({ signalingDelay: 2000 })]);
    const [obs] = ruleById('connectivity.signaling_delay').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('connectivity.slow_set_remote_description', () => {
  it('fires critical above the critical threshold', () => {
    const ctx = ctxWith([baseConnection({ setRemoteDescriptionDelay: 3000 })]);
    const [obs] = ruleById('connectivity.slow_set_remote_description').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('connectivity.slow_set_local_description', () => {
  it('fires warning above the warning threshold', () => {
    const ctx = ctxWith([baseConnection({ setLocalDescriptionDelay: 800 })]);
    const [obs] = ruleById('connectivity.slow_set_local_description').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});
