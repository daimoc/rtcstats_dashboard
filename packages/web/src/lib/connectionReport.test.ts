import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readRTCStatsDump } from '@rtcstats/rtcstats-shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildConnectionReports, summarizeConstraints, type ConnectionReport } from './connectionReport.js';
import type { DecodedDump, TraceEvent } from './dumpTypes.js';

const FIXTURE = new URL('../../../../test/fixtures/sample_30min.gz', import.meta.url);

function ev(timestamp: number, type: string, value: unknown = null, extra: unknown[] = []): TraceEvent {
  return { timestamp, type, value, extra };
}

function dumpOf(peerConnections: Record<string, TraceEvent[]>): DecodedDump {
  return { peerConnections };
}

describe('buildConnectionReports on the fixture call', () => {
  let reports: ConnectionReport[];
  let pc1: ConnectionReport;

  beforeAll(async () => {
    const raw = gunzipSync(readFileSync(FIXTURE));
    const dump = (await readRTCStatsDump(new Blob([raw]))) as unknown as DecodedDump;
    reports = buildConnectionReports(dump);
    pc1 = reports.find((r) => r.pcId === 'PC_1')!;
  });

  it('reports every peer connection, never the page-level trace', () => {
    expect(reports.map((r) => r.pcId)).toEqual(['PC_0', 'PC_1']);
  });

  it('reads the configuration from create', () => {
    expect(pc1.iceServers).toEqual(['stun:meet-jit-si-turnrelay.jitsi.net:443']);
    expect(pc1.bundlePolicy).toBe('max-bundle');
  });

  it('lays out contiguous state lanes from creation to the end of the connection', () => {
    for (const lane of pc1.lanes) {
      expect(lane.segments[0].from).toBe(pc1.createdAt);
      expect(lane.segments[lane.segments.length - 1].to).toBe(pc1.endAt);
      for (let i = 1; i < lane.segments.length; i++) {
        expect(lane.segments[i].from).toBe(lane.segments[i - 1].to);
      }
    }
    const connection = pc1.lanes.find((l) => l.key === 'connection')!;
    expect(connection.segments.map((s) => s.state)).toEqual(['new', 'connecting', 'connected']);
  });

  it('measures the connection set-up and how long it stayed connected', () => {
    expect(pc1.timings.timeToConnected).toBeGreaterThan(0);
    expect(pc1.timings.iceConnect).toBeGreaterThanOrEqual(0);
    expect(pc1.timings.iceGathering).toBeGreaterThan(0);
    expect(pc1.timings.firstNegotiation).toBeGreaterThanOrEqual(0);
    expect(pc1.timings.negotiations).toBe(1);
    expect(pc1.timings.disconnections).toBe(0);
    // A ~31 minute call.
    expect(pc1.timings.connectedFor).toBeGreaterThan(25 * 60 * 1000);
    expect(pc1.finalState.connection).toBe('closed');
    expect(pc1.milestones.map((m) => m.label)).toEqual([
      'Created', 'Negotiation started', 'ICE checking', 'ICE connected', 'Connected', 'Closed'
    ]);
  });

  it('counts each renegotiation of the JVB connection', () => {
    const pc0 = reports.find((r) => r.pcId === 'PC_0')!;
    expect(pc0.timings.negotiations).toBe(3);
    expect(pc0.dataChannels).toEqual([
      expect.objectContaining({ label: 'JVB data channel', protocol: 'http://jitsi.org/protocols/colibri' })
    ]);
  });

  it('lists local and remote tracks', () => {
    const summary = pc1.tracks.map((t) => `${t.direction} ${t.kind}`);
    expect(summary).toEqual(['local audio', 'local video', 'remote audio', 'remote video']);
    expect(pc1.tracks.find((t) => t.direction === 'remote' && t.kind === 'video')?.label).toBe('351875cd-video-0-1');
  });

  it('ties local tracks to the capture device behind them', () => {
    const mic = pc1.tracks.find((t) => t.direction === 'local' && t.kind === 'audio')!;
    expect(mic.device).toMatchObject({
      label: 'Jabra EVOLVE Link MS Mono',
      source: 'camera/microphone',
      requested: 'AEC · NS · AGC'
    });
    expect(mic.device?.deviceId).toMatch(/^f96ff582/);
    expect(mic.device?.groupId).toBeTruthy();

    const camera = pc1.tracks.find((t) => t.direction === 'local' && t.kind === 'video')!;
    expect(camera.device?.label).toBe('HP HD Camera (04ca:7054)');
    expect(camera.device?.requested).toBe('~1280×~720 · 15–30 fps');

    expect(pc1.tracks.filter((t) => t.direction === 'remote').every((t) => t.device === null)).toBe(true);
  });

  it('follows a remote track from muted to live once media flows', () => {
    const remoteVideo = pc1.tracks.find((t) => t.direction === 'remote' && t.kind === 'video')!;
    expect(remoteVideo.spans.map((s) => s.state)).toEqual(['muted', 'live']);
  });

  it('ends a local track when its capture is stopped at page level', () => {
    const mic = pc1.tracks.find((t) => t.direction === 'local' && t.kind === 'audio')!;
    expect(mic.endReason).toBe('stopped');
    expect(mic.endedAt).not.toBeNull();
  });

  it('keeps only this connection\'s events', () => {
    expect(pc1.events.length).toBeGreaterThan(0);
    expect(pc1.events.every((e) => e.pcId === 'PC_1')).toBe(true);
  });
});

describe('buildConnectionReports on a LiveKit call', () => {
  // LiveKit publishes with addTransceiver(track, {direction: 'sendonly'}) rather than
  // addTrack, and removes senders by sender id when it unpublishes.
  let reports: ConnectionReport[];

  beforeAll(async () => {
    const raw = gunzipSync(readFileSync(new URL('../../../../test/fixtures/dump_livekit.gz', import.meta.url)));
    reports = buildConnectionReports((await readRTCStatsDump(new Blob([raw]))) as unknown as DecodedDump);
  });

  const byPc = (pcId: string) => reports.find((r) => r.pcId === pcId)!;

  it('shows the media published with addTransceiver on the publisher connection', () => {
    const published = byPc('PC_1').tracks;
    expect(published.map((t) => `${t.direction} ${t.kind} ${t.trackId}`)).toEqual([
      'local audio 4050bd84-0cc6-4ee6-bf19-d266f181ddd2',
      'local video a98cb143-a3f4-491d-a16b-aabfa864285d'
    ]);
  });

  it('identifies the device behind a published track the capture did not hand out directly', () => {
    // The published tracks are LiveKit's own, so their ids never appear in a
    // getUserMedia result; the capture with the same kind and label is the source.
    const [mic, camera] = byPc('PC_1').tracks;
    expect(mic.device).toMatchObject({ label: 'Default', deviceId: 'default' });
    expect(mic.device?.requested).toBe('AEC · NS · AGC');
    expect(camera.device).toMatchObject({ label: 'Integrated Webcam', source: 'camera/microphone' });
    expect(camera.device?.groupId).toBeTruthy();
  });

  it('ends a published track when its sender is removed', () => {
    const [mic, camera] = byPc('PC_1').tracks;
    expect(mic.endReason).toBe('removed');
    expect(camera.endReason).toBe('removed');
    expect(mic.endedAt).toBeLessThan(byPc('PC_1').endAt);
  });

  it('ignores receive-only transceivers that carry no track', () => {
    expect(byPc('PC_0').tracks).toEqual([]);
  });

  it('still lists the subscribed tracks', () => {
    expect(byPc('PC_2').tracks.map((t) => `${t.direction} ${t.kind}`)).toEqual(['remote audio', 'remote video']);
  });
});

describe('buildConnectionReports on synthetic traces', () => {
  it('marks failures and disconnections as bad segments', () => {
    const [report] = buildConnectionReports(dumpOf({
      PC_0: [
        ev(0, 'create', { iceServers: [{ urls: ['turn:a', 'turns:b'] }] }),
        ev(100, 'oniceconnectionstatechange', 'checking'),
        ev(300, 'oniceconnectionstatechange', 'connected'),
        ev(1000, 'oniceconnectionstatechange', 'disconnected'),
        ev(1500, 'restartIce'),
        ev(2000, 'oniceconnectionstatechange', 'failed'),
        ev(3000, 'getStats', {})
      ]
    }));
    expect(report.iceServers).toEqual(['turn:a', 'turns:b']);
    expect(report.closedAt).toBeNull();
    expect(report.endAt).toBe(3000);
    expect(report.finalState.ice).toBe('failed');
    expect(report.timings.iceConnect).toBe(200);
    expect(report.timings.timeToConnected).toBeNull();
    expect(report.timings.disconnections).toBe(2);
    expect(report.timings.iceRestarts).toBe(1);
    const ice = report.lanes.find((l) => l.key === 'ice')!;
    expect(ice.segments.map((s) => s.tone)).toEqual(['pending', 'pending', 'good', 'bad', 'bad']);
  });

  it('splits a track into live and muted spans', () => {
    const [report] = buildConnectionReports(dumpOf({
      PC_0: [
        ev(0, 'create', {}),
        ev(10, 'addTrack', ['audio', 'mic-1', 'USB mic']),
        ev(100, 'MediaStreamTrack.onmute', 'mic-1'),
        ev(200, 'MediaStreamTrack.onunmute', 'mic-1'),
        ev(500, 'close')
      ]
    }));
    expect(report.tracks[0].spans).toEqual([
      { state: 'live', from: 10, to: 100 },
      { state: 'muted', from: 100, to: 200 },
      { state: 'live', from: 200, to: 500 }
    ]);
    // No capture request was logged, so the device is unknown.
    expect(report.tracks[0].device).toBeNull();
  });

  it('identifies a screen share and its device by label when no deviceId was pinned', () => {
    const [report] = buildConnectionReports(dumpOf({
      null: [
        ev(0, 'navigator.mediaDevices.enumerateDevices', [{ deviceId: 'cam-9', kind: 'videoinput', label: 'Webcam', groupId: 'g1' }]),
        ev(1, 'navigator.mediaDevices.getUserMedia', { video: true }, ['r1']),
        ev(2, 'navigator.mediaDevices.getUserMediaOnSuccess', [['video', 'v-1', 'Webcam', 's1']], ['r1']),
        ev(3, 'navigator.mediaDevices.getDisplayMedia', { video: true }, ['r2']),
        ev(4, 'navigator.mediaDevices.getDisplayMediaOnSuccess', [['video', 'screen-1', '', 's2']], ['r2'])
      ],
      PC_0: [
        ev(5, 'create', {}),
        ev(6, 'addTrack', ['video', 'v-1', 'Webcam']),
        ev(7, 'addTrack', ['video', 'screen-1', 'screen']),
        ev(8, 'close')
      ]
    }));
    expect(report.tracks[0].device).toMatchObject({ label: 'Webcam', deviceId: 'cam-9', groupId: 'g1' });
    expect(report.tracks[1].device).toMatchObject({ label: 'Screen capture', source: 'screen' });
  });

  it('returns nothing for a dump without peer connections', () => {
    expect(buildConnectionReports(dumpOf({ null: [ev(0, 'create', {})] }))).toEqual([]);
    expect(buildConnectionReports(null)).toEqual([]);
  });
});

describe('summarizeConstraints', () => {
  it('summarises video resolution and frame rate', () => {
    expect(summarizeConstraints('video', { width: { exact: 640 }, height: { exact: 480 }, frameRate: 30 }))
      .toBe('640×480 · 30 fps');
  });

  it('lists the audio processing that was asked for', () => {
    expect(summarizeConstraints('audio', { echoCancellation: true, noiseSuppression: false })).toBe('AEC');
    expect(summarizeConstraints('audio', true)).toBeNull();
  });
});
