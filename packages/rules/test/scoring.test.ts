import { describe, it, expect } from 'vitest';
import { score } from '../src/scoring.js';
import { defaultThresholds } from '../src/thresholds.js';
import type { Observation, RuleContext } from '../src/types.js';

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client: null,
    connections: [
      {
        id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
        iceConnected: true, iceConnectionTime: 500, iceRestart: false,
        addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
        connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: true,
        firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
        averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
        signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
        clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
        tracks: [
          { id: 1, connectionId: 1, trackIdentifier: 'v0', kind: 'video', direction: 'sendrecv',
            frameCount: 1000, qualityLimitationResolutionChanges: 0,
            bandwidthQualityLimitationPercentage: 0, cpuQualityLimitationPercentage: 0, otherQualityLimitationPercentage: 0,
            averageEncodeTime: 5, averageDecodeTime: 5, freezeCount: 0, totalFreezesDuration: 0,
            qpSum: 10000, encoderImplementation: 'libvpx', powerEfficientEncoder: true,
            decoderImplementation: 'libvpx', powerEfficientDecoder: true, hasNullVideoDecoder: false,
            concealedSamples: null, totalSamplesReceived: null, concealmentPercentage: null,
            jitterBufferFlushes: null, hasPeriodicJitterBufferFlushes: null,
            insertedSamplesForDeceleration: null, removedSamplesForAcceleration: null,
            decelerationPercentage: null, accelerationPercentage: null, timeToFirstFrame: 300 }
        ]
      }
    ],
    thresholds: defaultThresholds,
    ...overrides
  };
}

describe('score', () => {
  it('scores a clean session at 100 across all applicable categories', () => {
    const result = score([], makeCtx());
    expect(result.connectivity).toBe(100);
    expect(result.video).toBe(100);
    expect(result.audio).toBeNull();
    expect(result.experience).toBe(100);
  });

  it('subtracts a critical connectivity observation from connectivity and experience', () => {
    const observations: Observation[] = [
      { type: 'connectivity.slow_ice_connect', severity: 'critical', category: 'connectivity',
        pid: 'PC_0', firstSeenAt: 0, observation: {} }
    ];
    const result = score(observations, makeCtx());
    expect(result.connectivity).toBe(85);
    expect(result.video).toBe(100);
    expect(result.experience).toBeCloseTo(92.5, 5);
  });

  it('clamps a category score at 0 rather than going negative', () => {
    const observations: Observation[] = [
      { type: 'connectivity.never_connected', severity: 'critical', category: 'connectivity',
        pid: 'PC_0', firstSeenAt: 0, observation: {} },
      { type: 'connectivity.slow_ice_connect', severity: 'critical', category: 'connectivity',
        pid: 'PC_0', firstSeenAt: 0, observation: {} }
    ];
    const result = score(observations, makeCtx());
    expect(result.connectivity).toBe(0);
  });

  it('reduces experience by device/api weight without a dedicated device score', () => {
    const observations: Observation[] = [
      { type: 'device.get_user_media_failure', severity: 'critical', category: 'device',
        pid: null, firstSeenAt: 0, observation: {} }
    ];
    const result = score(observations, makeCtx());
    expect(result.connectivity).toBe(100);
    expect(result.video).toBe(100);
    expect(result.experience).toBe(70);
  });
});
