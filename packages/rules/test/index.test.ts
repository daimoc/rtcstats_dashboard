import { describe, it, expect } from 'vitest';
import { analyze, buildRegistry, defaultThresholds, RULES_VERSION } from '../src/index.js';
import type { RuleContext } from '../src/index.js';

describe('index.ts public API', () => {
  it('exposes a semver RULES_VERSION', () => {
    expect(RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs the full real registry end-to-end on a multi-problem session', () => {
    const ctx: RuleContext = {
      metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
      client: {
        id: 1, dumpId: 1, hardwareConcurrency: 4, deviceMemory: 4,
        calledGetUserMedia: true, getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0, getUserMediaError: null,
        reloadCount: 0, cpuPerformance: 5, operatingSystem: 'Windows',
        audioEnded: false, audioShortDuration: false, videoEnded: false, videoShortDuration: false
      },
      connections: [{
        id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
        iceConnected: true, iceConnectionTime: 9000, iceRestart: false,
        addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
        connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
        firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
        averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
        signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
        clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
        tracks: [{
          id: 1, connectionId: 1, trackIdentifier: 'v0', kind: 'video', direction: 'recvonly',
          frameCount: 1000, qualityLimitationResolutionChanges: 0,
          bandwidthQualityLimitationPercentage: 0, cpuQualityLimitationPercentage: 0, otherQualityLimitationPercentage: 0,
          averageEncodeTime: null, averageDecodeTime: 5, freezeCount: 20, totalFreezesDuration: 25000,
          qpSum: 10000, encoderImplementation: null, powerEfficientEncoder: null,
          decoderImplementation: 'libvpx', powerEfficientDecoder: true, hasNullVideoDecoder: false,
          concealedSamples: null, totalSamplesReceived: null, concealmentPercentage: null,
          jitterBufferFlushes: null, hasPeriodicJitterBufferFlushes: null,
          insertedSamplesForDeceleration: null, removedSamplesForAcceleration: null,
          decelerationPercentage: null, accelerationPercentage: null, timeToFirstFrame: 300
        }]
      }],
      thresholds: defaultThresholds
    };

    const result = analyze(ctx, buildRegistry());
    expect(result.status).toBe('ok');
    const types = result.observations.map((o) => o.type);
    expect(types).toContain('connectivity.slow_ice_connect');
    expect(types).toContain('video.freezes');
    expect(result.scores?.connectivity).toBeLessThan(100);
    expect(result.scores?.video).toBeLessThan(100);
  });
});
