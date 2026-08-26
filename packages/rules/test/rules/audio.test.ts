import { describe, it, expect } from 'vitest';
import { audioRules } from '../../src/rules/audio.js';
import { defaultThresholds } from '../../src/thresholds.js';
import type { FeatureClient, FeatureConnection, FeatureTrack, RuleContext } from '../../src/types.js';

function baseAudioTrack(overrides: Partial<FeatureTrack> = {}): FeatureTrack {
  return {
    id: 1, connectionId: 1, trackIdentifier: 'a0', kind: 'audio', direction: 'sendrecv',
    frameCount: null, qualityLimitationResolutionChanges: null,
    bandwidthQualityLimitationPercentage: null, cpuQualityLimitationPercentage: null, otherQualityLimitationPercentage: null,
    averageEncodeTime: null, averageDecodeTime: null, freezeCount: null, totalFreezesDuration: null,
    qpSum: null, encoderImplementation: null, powerEfficientEncoder: null,
    decoderImplementation: null, powerEfficientDecoder: null, hasNullVideoDecoder: null,
    concealedSamples: 0, totalSamplesReceived: 100000, concealmentPercentage: 0,
    jitterBufferFlushes: 0, hasPeriodicJitterBufferFlushes: false,
    insertedSamplesForDeceleration: 0, removedSamplesForAcceleration: 0,
    decelerationPercentage: 0, accelerationPercentage: 0, timeToFirstFrame: null,
    ...overrides
  };
}

function ctxWith(track: FeatureTrack | null, client: FeatureClient | null = null): RuleContext {
  const connection: FeatureConnection = {
    id: 1, dumpId: 1, connectionIdentifier: 'PC_0', closed: true,
    iceConnected: true, iceConnectionTime: 500, iceRestart: false,
    addIceCandidateFailure: null, setLocalDescriptionFailure: null, setRemoteDescriptionFailure: null,
    connected: true, dtlsVersion: '1.2', dtlsRole: 'client', addedNullCandidate: false,
    firstCandidatePairLocalType: 'host', firstCandidatePairRemoteType: 'host',
    averageStunRoundTripTime: 20, iceRestartFollowedBySetRemoteDescription: false,
    signalingDelay: 100, setRemoteDescriptionDelay: 50, setLocalDescriptionDelay: 50,
    clockSkew: 0, gatheringTimeTurnUdp: null, gatheringTimeTurnTcp: null, gatheringTimeTurnTls: null,
    tracks: track ? [track] : []
  };
  return {
    metadata: { id: 1, dumpId: 1, startTime: null, useragent: null, numberPeerconnections: 1 },
    client,
    connections: [connection],
    thresholds: defaultThresholds
  };
}

function ruleById(id: string) {
  const rule = audioRules.find((r) => r.id === id);
  if (!rule) throw new Error(`rule ${id} not registered`);
  return rule;
}

describe('audio.concealment_ratio', () => {
  it('does not fire under the warning percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ concealmentPercentage: 1 }));
    expect(ruleById('audio.concealment_ratio').evaluate(ctx)).toHaveLength(0);
  });

  it('fires critical above the critical percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ concealmentPercentage: 10 }));
    const [obs] = ruleById('audio.concealment_ratio').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });
});

describe('audio.jitter_buffer_flushes', () => {
  it('fires warning above the warning count', () => {
    const ctx = ctxWith(baseAudioTrack({ jitterBufferFlushes: 5, hasPeriodicJitterBufferFlushes: false }));
    const [obs] = ruleById('audio.jitter_buffer_flushes').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('fires critical when flushes are periodic regardless of count', () => {
    const ctx = ctxWith(baseAudioTrack({ jitterBufferFlushes: 1, hasPeriodicJitterBufferFlushes: true }));
    const [obs] = ruleById('audio.jitter_buffer_flushes').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('does not fire for a couple of one-off flushes', () => {
    const ctx = ctxWith(baseAudioTrack({ jitterBufferFlushes: 1, hasPeriodicJitterBufferFlushes: false }));
    expect(ruleById('audio.jitter_buffer_flushes').evaluate(ctx)).toHaveLength(0);
  });
});

describe('audio.time_stretching', () => {
  it('fires critical when deceleration exceeds the critical percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ decelerationPercentage: 20, accelerationPercentage: 0 }));
    const [obs] = ruleById('audio.time_stretching').evaluate(ctx);
    expect(obs.severity).toBe('critical');
  });

  it('fires warning when acceleration exceeds the warning percentage', () => {
    const ctx = ctxWith(baseAudioTrack({ decelerationPercentage: 0, accelerationPercentage: 7 }));
    const [obs] = ruleById('audio.time_stretching').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });
});

describe('audio.track_ended_unexpectedly', () => {
  it('fires warning when the audio track ended after a short duration', () => {
    const client: FeatureClient = {
      id: 1, dumpId: 1, hardwareConcurrency: 8, deviceMemory: 8,
      calledGetUserMedia: true, getUserMediaSuccessCount: 1, getUserMediaErrorCount: 0, getUserMediaError: null,
      reloadCount: 0, cpuPerformance: 5, operatingSystem: 'macOS',
      audioEnded: true, audioShortDuration: true, videoEnded: false, videoShortDuration: false
    };
    const ctx = ctxWith(baseAudioTrack(), client);
    const [obs] = ruleById('audio.track_ended_unexpectedly').evaluate(ctx);
    expect(obs.severity).toBe('warning');
  });

  it('does not fire when there is no client feature row', () => {
    const ctx = ctxWith(baseAudioTrack(), null);
    expect(ruleById('audio.track_ended_unexpectedly').evaluate(ctx)).toHaveLength(0);
  });
});
