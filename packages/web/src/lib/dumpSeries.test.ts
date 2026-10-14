import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readRTCStatsDump } from '@rtcstats/rtcstats-shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildConnectionSeries, type ConnectionSeries } from './dumpSeries.js';
import type { DecodedDump } from './dumpTypes.js';

const FIXTURE = new URL('../../../../test/fixtures/sample_30min.gz', import.meta.url);

function chart(series: ConnectionSeries, key: string) {
  const found = series.charts.find((c) => c.key === key);
  if (!found) throw new Error(`no chart ${key}`);
  return found;
}

function values(series: ConnectionSeries, chartKey: string, label: string): number[] {
  const found = chart(series, chartKey).series.find((s) => s.label === label);
  if (!found) throw new Error(`no series ${label} in ${chartKey}`);
  return found.values.filter((v): v is number => v != null);
}

describe('buildConnectionSeries', () => {
  let dump: DecodedDump;
  let pc0: ConnectionSeries;
  let pc1: ConnectionSeries;

  beforeAll(async () => {
    const raw = gunzipSync(readFileSync(FIXTURE));
    dump = (await readRTCStatsDump(new Blob([raw]))) as unknown as DecodedDump;
    pc0 = buildConnectionSeries(dump.peerConnections['PC_0'])!;
    pc1 = buildConnectionSeries(dump.peerConnections['PC_1'])!;
  });

  it('produces a shared time axis covering the call', () => {
    // The bug this replaces: charts were empty for every session.
    expect(pc0).not.toBeNull();
    expect(pc0.x.length).toBeGreaterThan(1000);
    expect(pc0.x[0]).toBe(0);
    // The fixture is a ~31 minute call.
    expect(pc0.x[pc0.x.length - 1]).toBeGreaterThan(1800);
    expect([...pc0.x]).toEqual([...pc0.x].sort((a, b) => a - b));
    expect(pc0.charts.map((c) => c.key)).toEqual([
      'mos', 'video-bitrate', 'audio-bitrate', 'rtt', 'jitter',
      'loss', 'framerate', 'resolution', 'freezes'
    ]);
  });

  it('every series is aligned to the shared x axis', () => {
    for (const connection of [pc0, pc1]) {
      for (const c of connection.charts) {
        for (const s of c.series) {
          expect(s.values.length).toBe(connection.x.length);
        }
      }
    }
  });

  it('converts cumulative byte counters into a plausible bitrate', () => {
    const outboundVideo = values(pc1, 'video-bitrate', 'Outbound video');
    expect(outboundVideo.length).toBeGreaterThan(1000);
    expect(Math.min(...outboundVideo)).toBeGreaterThanOrEqual(0);
    // A 720p video stream, not a raw ever-rising byte total.
    expect(Math.max(...outboundVideo)).toBeGreaterThan(100_000);
    expect(Math.max(...outboundVideo)).toBeLessThan(10_000_000);
  });

  it('never emits a negative rate when a counter resets', () => {
    for (const connection of [pc0, pc1]) {
      for (const [chartKey, label] of [
        ['audio-bitrate', 'Outbound audio'],
        ['video-bitrate', 'Outbound video'],
        ['video-bitrate', 'Inbound video']
      ] as const) {
        expect(Math.min(...values(connection, chartKey, label))).toBeGreaterThanOrEqual(0);
      }
      expect(Math.min(...values(connection, 'loss', 'Packet loss'))).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports jitter in milliseconds', () => {
    const jitter = values(pc1, 'jitter', 'Inbound audio');
    expect(Math.max(...jitter)).toBeGreaterThan(0);
    expect(Math.max(...jitter)).toBeLessThan(1000);
  });

  it('charts the nominated candidate pair that owns the bandwidth estimate', () => {
    // PC_1 has two nominated pairs; only one carries availableOutgoingBitrate, and
    // picking the other one silently drops the series.
    const rtt = values(pc1, 'rtt', 'Round-trip time');
    expect(Math.max(...rtt)).toBeGreaterThan(0);
    expect(Math.max(...rtt)).toBeLessThan(1000);

    const available = values(pc1, 'video-bitrate', 'Available outgoing');
    expect(available.length).toBeGreaterThan(1000);
    expect(Math.min(...available)).toBeGreaterThan(100_000);
  });

  it('charts video health with real frame rates and resolutions', () => {
    const fps = values(pc1, 'framerate', 'Inbound video');
    expect(Math.max(...fps)).toBeGreaterThan(10);
    expect(Math.max(...fps)).toBeLessThanOrEqual(120);

    const height = values(pc1, 'resolution', 'Inbound video');
    expect(Math.max(...height)).toBe(720);
  });

  it('charts the received audio and video MOS on a fixed 1-5 scale', () => {
    const mos = chart(pc1, 'mos');
    expect(mos.range).toEqual([1, 5]);
    expect(mos.series.map((s) => s.label)).toEqual(['Inbound audio', 'Inbound video']);
    for (const label of ['Inbound audio', 'Inbound video']) {
      const scores = values(pc1, 'mos', label);
      expect(scores.length).toBeGreaterThan(1000);
      expect(Math.min(...scores)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...scores)).toBeLessThanOrEqual(5);
    }
    // Bitrate charts keep their data-driven axis.
    expect(chart(pc1, 'video-bitrate').range).toBeUndefined();
  });

  it('gives every chart a single unit, never two y scales', () => {
    for (const connection of [pc0, pc1]) {
      for (const c of connection.charts) {
        expect(c.unit).toBeTruthy();
      }
    }
    // Measures of different scale live in different charts.
    expect(chart(pc1, 'video-bitrate').unit).toBe('bits/s');
    expect(chart(pc1, 'rtt').unit).toBe('ms');
    expect(chart(pc1, 'loss').unit).toBe('lost/s');
    expect(chart(pc1, 'framerate').unit).toBe('frames/s');
  });

  it('keeps a series colour tied to its entity, not to its position', () => {
    // Inbound video is the same colour in every chart it appears in, so a chart that
    // loses a series never repaints the survivors.
    const inboundVideoBitrate = chart(pc1, 'video-bitrate').series.find((s) => s.label === 'Inbound video');
    const inboundVideoFps = chart(pc1, 'framerate').series.find((s) => s.label === 'Inbound video');
    expect(inboundVideoBitrate?.colorSlot).toBe(inboundVideoFps?.colorSlot);

    const outboundVideoBitrate = chart(pc1, 'video-bitrate').series.find((s) => s.label === 'Outbound video');
    expect(outboundVideoBitrate?.colorSlot).not.toBe(inboundVideoBitrate?.colorSlot);
  });

  it('returns null for a trace with no stats rather than an empty plot', () => {
    // Page-level events (getUserMedia, websocket) belong to no peer connection.
    expect(buildConnectionSeries(dump.peerConnections['null'])).toBeNull();
    expect(buildConnectionSeries([])).toBeNull();
    expect(buildConnectionSeries(undefined)).toBeNull();
  });
});

describe('chart palette assignment', () => {
  it('never puts the two least-separable palette slots in the same chart', async () => {
    // Slots 1 (yellow) and 3 (green) only reach the 6-8 CVD floor band against each
    // other in dark mode, so no chart may draw both. Splitting round-trip time out of
    // the jitter chart is what makes this hold.
    const raw = gunzipSync(readFileSync(FIXTURE));
    const dump = (await readRTCStatsDump(new Blob([raw]))) as unknown as DecodedDump;

    for (const pcId of ['PC_0', 'PC_1']) {
      const series = buildConnectionSeries(dump.peerConnections[pcId])!;
      for (const c of series.charts) {
        const slots = c.series.map((s) => s.colorSlot);
        expect(slots.includes(1) && slots.includes(3)).toBe(false);
        // A colour is never reused for two different series inside one chart.
        expect(new Set(slots).size).toBe(slots.length);
      }
    }
  });
});
