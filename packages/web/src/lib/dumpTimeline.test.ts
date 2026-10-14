import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readRTCStatsDump } from '@rtcstats/rtcstats-shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTimeline, type TimelineEvent } from './dumpTimeline.js';
import type { DecodedDump } from './dumpTypes.js';

const FIXTURE = new URL('../../../../test/fixtures/sample_30min.gz', import.meta.url);

async function decodeFixture(): Promise<DecodedDump> {
  const raw = gunzipSync(readFileSync(FIXTURE));
  return (await readRTCStatsDump(new Blob([raw]))) as unknown as DecodedDump;
}

describe('buildTimeline', () => {
  let dump: DecodedDump;
  let events: TimelineEvent[];

  beforeAll(async () => {
    dump = await decodeFixture();
    events = buildTimeline(dump);
  });

  it('produces events for a real dump', () => {
    // The bug this replaces: the timeline was empty for every session because every
    // candidate event had a null timestamp and was filtered away.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => Number.isFinite(e.timestamp))).toBe(true);
  });

  it('orders events chronologically', () => {
    const timestamps = events.map((e) => e.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('excludes the high-volume methods that are chart data, not timeline data', () => {
    const types = new Set(events.map((e) => e.type));
    expect(types.has('getStats')).toBe(false);
    expect(types.has('onicecandidate')).toBe(false);
    expect(types.has('addIceCandidate')).toBe(false);
  });

  it('keeps every peer connection lifecycle event from the fixture', () => {
    const count = (pcId: string, type: string) =>
      events.filter((e) => e.pcId === pcId && e.type === type).length;

    expect(count('PC_0', 'ontrack')).toBe(4);
    expect(count('PC_0', 'oniceconnectionstatechange')).toBe(2);
    expect(count('PC_0', 'HTMLMediaElement.resize')).toBe(2);
    expect(count('PC_1', 'onicecandidateerror')).toBe(2);
    expect(count('PC_1', 'ontrack')).toBe(2);
  });

  it('labels state changes with the state and flags the bad ones', () => {
    const iceStates = events.filter((e) => e.type === 'oniceconnectionstatechange');
    expect(iceStates.map((e) => e.label)).toContain('ICE connection: checking');
    expect(iceStates.every((e) => e.severity === 'info')).toBe(true);

    const candidateErrors = events.filter((e) => e.type === 'onicecandidateerror');
    expect(candidateErrors.every((e) => e.severity === 'warning')).toBe(true);
    expect(candidateErrors[0].details).toContain('STUN host lookup received error.');
  });

  it('describes media events using the values in the dump', () => {
    const resize = events.find((e) => e.type === 'HTMLMediaElement.resize');
    expect(resize?.label).toBe('Video resized to 320×180');
    expect(resize?.details).toBe('remote-video-1');

    const remoteTrack = events.find((e) => e.type === 'ontrack');
    expect(remoteTrack?.label).toBe('Remote audio track added');
  });

  it('distinguishes the signaling websocket closing from a peer connection closing', () => {
    const closes = events.filter((e) => e.type === 'close');
    expect(closes.find((e) => e.pcId === 'null')?.label).toBe('Signaling websocket closed');
    expect(closes.find((e) => e.pcId === 'PC_0')?.label).toBe('Peer connection closed');
  });

  it('returns an empty timeline for a missing dump rather than throwing', () => {
    expect(buildTimeline(null)).toEqual([]);
    expect(buildTimeline({ peerConnections: {} })).toEqual([]);
  });
});
