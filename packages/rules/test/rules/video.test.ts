import { describe, it, expect } from 'vitest';
import { videoRules } from '../../src/rules/video.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureConnection, FeatureTrack, RuleContext } from '../../src/types.js';

function baseTrack(overrides: Partial<FeatureTrack> = {}): FeatureTrack {
  return {
    id: 1, connectionId: 1, trackIdentifier: 'v0', kind: 'video', direction: 'sendrecv',
    frameCount: 1000, qualityLimitationResolutionChanges: 0,
    bandwidthQualityLimitationPercentage: 0, cpuQualityLimitationPercentage: 0, otherQualityLimitationPercentage: 0,
    averageEncodeTime: 5, averageDecodeTime: 5, freezeCount: 0, totalFreezesDuration: 0,
    qpSum: 10000, encoderImplementation: 'libvpx', powerEfficientEncoder: true,
    decoderImplementation: 'libvpx', powerEfficientDecoder: true, hasNullVideoDecoder: false,
    concealedSamples: null, totalSamplesReceived: null, concealmentPercentage: null,
    jitterBufferFlushes: null, hasPeriodicJitterBufferFlushes: null,
    insertedSamplesForDeceleration: null, removedSamplesForAcceleration: null,
    decelerationPercentage: null, accelerationPercentage: null, timeToFirstFrame: 300,
    ...overrides
  };
}

function ctxWithTrack(track: FeatureTrack): RuleContext {
  const connection: FeatureConnection = {
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: [track]
  };
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client: null,
    connections: [connection],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = videoRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('video.freezes', () => {
  it('does not fire under the warning threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ freezeCount: 2, totalFreezesDuration: 2000 }));
    expect(ruleById('video.freezes').evaluate(ctx)).toHaveLength(0);
  });

  it('fires critical above the critical threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ freezeCount: 10, totalFreezesDuration: 20000 }));
    const [obs] = ruleById('video.freezes').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.observation.totalFreezesDuration).toBe(20000);
  });

  it('ignores a track with no freezes recorded', () => {
    const ctx = ctxWithTrack(baseTrack({ freezeCount: 0, totalFreezesDuration: 0 }));
    expect(ruleById('video.freezes').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.quality_limitation_cpu', () => {
  it('fires warning above the warning percentage', () => {
    const ctx = ctxWithTrack(baseTrack({ cpuQualityLimitationPercentage: 25 }));
    const [obs] = ruleById('video.quality_limitation_cpu').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('video.quality_limitation_bandwidth', () => {
  it('fires critical above the critical percentage', () => {
    const ctx = ctxWithTrack(baseTrack({ bandwidthQualityLimitationPercentage: 60 }));
    const [obs] = ruleById('video.quality_limitation_bandwidth').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('video.frequent_resolution_changes', () => {
  it('fires warning above the warning count', () => {
    const ctx = ctxWithTrack(baseTrack({ qualityLimitationResolutionChanges: 7 }));
    const [obs] = ruleById('video.frequent_resolution_changes').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('video.slow_time_to_first_frame', () => {
  it('fires critical above the critical threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ timeToFirstFrame: 6000 }));
    const [obs] = ruleById('video.slow_time_to_first_frame').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire when unset', () => {
    const ctx = ctxWithTrack(baseTrack({ timeToFirstFrame: null }));
    expect(ruleById('video.slow_time_to_first_frame').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.slow_encode', () => {
  it('fires warning above the warning threshold for a sending track', () => {
    const ctx = ctxWithTrack(baseTrack({ direction: 'sendonly', averageEncodeTime: 25 }));
    const [obs] = ruleById('video.slow_encode').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire for a receive-only track', () => {
    const ctx = ctxWithTrack(baseTrack({ direction: 'recvonly', averageEncodeTime: 100 }));
    expect(ruleById('video.slow_encode').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.slow_decode', () => {
  it('fires warning above the warning threshold for a receiving track', () => {
    const ctx = ctxWithTrack(baseTrack({ direction: 'recvonly', averageDecodeTime: 25 }));
    const [obs] = ruleById('video.slow_decode').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('video.no_hw_acceleration', () => {
  it('fires info when the decoder is not power efficient', () => {
    const ctx = ctxWithTrack(baseTrack({ decoderImplementation: 'libvpx', powerEfficientDecoder: false }));
    const [obs] = ruleById('video.no_hw_acceleration').evaluate(ctx);
    expect(obs.severity).toBe('info');
  });

  it('does not fire when the implementation is unknown', () => {
    const ctx = ctxWithTrack(baseTrack({ decoderImplementation: null, powerEfficientDecoder: null }));
    expect(ruleById('video.no_hw_acceleration').evaluate(ctx)).toHaveLength(0);
  });
});

describe('video.null_video_decoder', () => {
  it('fires critical when the decoder is null', () => {
    const ctx = ctxWithTrack(baseTrack({ hasNullVideoDecoder: true }));
    const [obs] = ruleById('video.null_video_decoder').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('video.qp_degradation', () => {
  it('fires critical when average QP exceeds the critical threshold', () => {
    const ctx = ctxWithTrack(baseTrack({ frameCount: 1000, qpSum: 45000 }));
    const [obs] = ruleById('video.qp_degradation').evaluate(ctx);
    expect(obs.severity).toBe('critical');
    expect(obs.observation.averageQp).toBe(45);
  });

  it('does not fire when there are no frames to average over', () => {
    const ctx = ctxWithTrack(baseTrack({ frameCount: 0, qpSum: 0 }));
    expect(ruleById('video.qp_degradation').evaluate(ctx)).toHaveLength(0);
  });
});
