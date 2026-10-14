import { createRtcStatsTimeSeries } from '@rtcstats/rtcstats-shared';
import { audioMos, videoMos } from './models.js';

/** A `[timestamp, value]` pair as emitted by `createRtcStatsTimeSeries`. */
type RawPoint = [number, unknown];
type Point = [number, number];

/** One stats object's properties over time, plus its `RTCStatsType`. */
export interface StatsObject {
  type?: string;
  [property: string]: unknown;
}

/** `createRtcStatsTimeSeries` output: stats objects keyed by their stats id. */
export type StatsTimeSeries = Record<string, StatsObject>;

export interface MosSample {
  /** Epoch ms at the end of the interval the score describes. */
  t: number;
  mos: number;
  /** Length of that interval in seconds, the sample's weight in any average. */
  seconds: number;
}

/** MOS over time for what one peer connection received. */
export interface ConnectionMos {
  audio: MosSample[];
  video: MosSample[];
}

/**
 * Stats intervals longer than this are a gap (the tab was backgrounded, stats paused)
 * rather than a measurement, so they are not scored.
 */
const MAX_INTERVAL_SECONDS = 30;

function points(value: unknown): RawPoint[] {
  return Array.isArray(value) ? (value as RawPoint[]) : [];
}

function numeric(value: unknown): Point[] {
  return points(value).filter((p): p is Point => typeof p[1] === 'number' && Number.isFinite(p[1]));
}

function lastValue(value: unknown): unknown {
  const list = points(value);
  return list.length ? list[list.length - 1][1] : undefined;
}

function firstValue(value: unknown): unknown {
  const list = points(value);
  return list.length ? list[0][1] : undefined;
}

/**
 * The most recent value of a numeric property at or before `t`.
 *
 * Properties of one stats object are normally sampled together, but a property can be
 * missing from some reports (frameWidth before the first decoded frame), so a lookup
 * carries the last known value forward instead of requiring an exact timestamp match.
 */
function sampler(value: unknown): (t: number) => number | null {
  const series = numeric(value);
  return (t) => {
    let low = 0;
    let high = series.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (series[mid][0] <= t) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found >= 0 ? series[found][1] : null;
  };
}

/** Growth of a cumulative counter between two instants; a reset counts as no growth. */
function delta(at: (t: number) => number | null, t0: number, t1: number): number | null {
  const start = at(t0);
  const end = at(t1);
  if (start == null || end == null) return null;
  return Math.max(0, end - start);
}

function statsOfType(stats: StatsTimeSeries, type: string): StatsObject[] {
  return Object.values(stats).filter((s) => s.type === type);
}

function ofKind(objects: StatsObject[], kind: string): StatsObject[] {
  return objects.filter((s) => firstValue(s.kind) === kind || lastValue(s.kind) === kind);
}

/**
 * Pick the candidate pair that actually carried the media.
 *
 * A 30-minute call gathers dozens of pairs, most of which never leave `waiting`.
 * Narrow to the nominated ones (falling back to `succeeded`, then to everything, for
 * dumps that never set the flag), then rank within that pool. A connection can have more
 * than one nominated pair, and only the pair owning the bandwidth estimate reports
 * `availableOutgoingBitrate`, which makes it the best discriminator; sample count breaks
 * any remaining tie.
 */
export function selectActiveCandidatePair(stats: StatsTimeSeries): StatsObject | null {
  const pairs = statsOfType(stats, 'candidate-pair');
  if (pairs.length === 0) return null;

  const nominated = pairs.filter((p) => lastValue(p.nominated) === true);
  const succeeded = pairs.filter((p) => lastValue(p.state) === 'succeeded');
  const pool = nominated.length > 0 ? nominated : succeeded.length > 0 ? succeeded : pairs;

  const rank = (pair: StatsObject): [number, number] => [
    numeric(pair.availableOutgoingBitrate).length,
    numeric(pair.currentRoundTripTime).length
  ];

  return pool.reduce((best, pair) => {
    const [bandwidth, samples] = rank(pair);
    const [bestBandwidth, bestSamples] = rank(best);
    if (bandwidth !== bestBandwidth) return bandwidth > bestBandwidth ? pair : best;
    return samples > bestSamples ? pair : best;
  });
}

/**
 * Round-trip time in ms at any instant: from the ICE candidate pair, or failing that
 * from the RTCP-based `remote-inbound-rtp` reports. Unknown RTT is taken as 0, which
 * leaves the score to the loss and jitter that were measured.
 */
function rttSampler(stats: StatsTimeSeries): (t: number) => number {
  const pair = selectActiveCandidatePair(stats);
  const fromPair = sampler(pair?.currentRoundTripTime);
  const remote = statsOfType(stats, 'remote-inbound-rtp')
    .sort((a, b) => numeric(b.roundTripTime).length - numeric(a.roundTripTime).length)[0];
  const fromRtcp = sampler(remote?.roundTripTime);
  return (t) => (fromPair(t) ?? fromRtcp(t) ?? 0) * 1000;
}

function codecMimeType(stats: StatsTimeSeries, stream: StatsObject): string | null {
  const codecId = lastValue(stream.codecId);
  if (typeof codecId !== 'string') return null;
  const mimeType = lastValue(stats[codecId]?.mimeType);
  return typeof mimeType === 'string' ? mimeType : null;
}

/** Consecutive report instants of a stream, the boundaries of the scored intervals. */
function intervals(stream: StatsObject): [number, number, number][] {
  const clock = numeric(stream.bytesReceived).map(([t]) => t);
  const out: [number, number, number][] = [];
  for (let i = 1; i < clock.length; i++) {
    const seconds = (clock[i] - clock[i - 1]) / 1000;
    if (seconds <= 0 || seconds > MAX_INTERVAL_SECONDS) continue;
    out.push([clock[i - 1], clock[i], seconds]);
  }
  return out;
}

function audioStreamMos(stream: StatsObject, rttAt: (t: number) => number): MosSample[] {
  const received = sampler(stream.packetsReceived);
  const lost = sampler(stream.packetsLost);
  const jitter = sampler(stream.jitter);
  const bufferDelay = sampler(stream.jitterBufferDelay);
  const emitted = sampler(stream.jitterBufferEmittedCount);

  const samples: MosSample[] = [];
  for (const [t0, t1, seconds] of intervals(stream)) {
    const packets = delta(received, t0, t1);
    // Nothing arrived: the remote side is muted or not sending, which is not a quality
    // problem the listener can hear, so the interval is not scored.
    if (!packets) continue;
    const missing = delta(lost, t0, t1) ?? 0;

    const emittedSamples = delta(emitted, t0, t1);
    const delaySeconds = delta(bufferDelay, t0, t1);
    const jitterBufferDelayMs = emittedSamples && delaySeconds != null
      ? (delaySeconds / emittedSamples) * 1000
      : null;

    samples.push({
      t: t1,
      seconds,
      mos: audioMos({
        rttMs: rttAt(t1),
        jitterMs: (jitter(t1) ?? 0) * 1000,
        jitterBufferDelayMs,
        packetLossPct: (missing / (packets + missing)) * 100
      })
    });
  }
  return samples;
}

function videoStreamMos(stream: StatsObject, mimeType: string | null): MosSample[] {
  const bytes = sampler(stream.bytesReceived);
  const framesDecoded = sampler(stream.framesDecoded);
  const width = sampler(stream.frameWidth);
  const height = sampler(stream.frameHeight);
  const freezes = sampler(stream.totalFreezesDuration);

  const samples: MosSample[] = [];
  for (const [t0, t1, seconds] of intervals(stream)) {
    const received = delta(bytes, t0, t1);
    // No media at all: the sender paused or dropped this layer, nothing to score.
    if (!received) continue;

    const frames = delta(framesDecoded, t0, t1) ?? 0;
    if (frames === 0) {
      // Packets arrive yet nothing decodes: the viewer is looking at a frozen picture.
      samples.push({ t: t1, seconds, mos: 1 });
      continue;
    }

    const frameWidth = width(t1);
    const frameHeight = height(t1);
    if (!frameWidth || !frameHeight) continue;

    samples.push({
      t: t1,
      seconds,
      mos: videoMos({
        bitrateKbps: (received * 8) / seconds / 1000,
        frameRate: frames / seconds,
        frameWidth,
        frameHeight,
        // totalFreezesDuration grows when a freeze ends, so a long freeze lands in one
        // interval; capping at the interval keeps it from scoring below a frozen one.
        freezeRatio: Math.min(1, (delta(freezes, t0, t1) ?? 0) / seconds),
        mimeType
      })
    });
  }
  return samples;
}

/**
 * Average the per-stream scores of each instant into one connection-level series.
 *
 * Every inbound stream of a connection is reported by the same `getStats` call, so
 * streams line up on timestamps; a conference with four remote cameras scores the
 * average camera at each instant.
 */
function mergeStreams(streams: MosSample[][]): MosSample[] {
  const byInstant = new Map<number, { mos: number; seconds: number; count: number }>();
  for (const stream of streams) {
    for (const sample of stream) {
      const entry = byInstant.get(sample.t) ?? { mos: 0, seconds: 0, count: 0 };
      entry.mos += sample.mos;
      entry.seconds += sample.seconds;
      entry.count += 1;
      byInstant.set(sample.t, entry);
    }
  }
  return [...byInstant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, entry]) => ({ t, mos: entry.mos / entry.count, seconds: entry.seconds / entry.count }));
}

/** Score everything a peer connection received, from its decoded stats time series. */
export function computeConnectionMos(stats: StatsTimeSeries): ConnectionMos {
  const inbound = statsOfType(stats, 'inbound-rtp');
  const rttAt = rttSampler(stats);

  return {
    audio: mergeStreams(ofKind(inbound, 'audio').map((stream) => audioStreamMos(stream, rttAt))),
    video: mergeStreams(ofKind(inbound, 'video').map((stream) => videoStreamMos(stream, codecMimeType(stats, stream))))
  };
}

/** Same as `computeConnectionMos`, starting from a peer connection's raw dump trace. */
export function computeTraceMos(trace: unknown[]): ConnectionMos {
  return computeConnectionMos(createRtcStatsTimeSeries(trace) as StatsTimeSeries);
}
