import { createRtcStatsTimeSeries } from '@rtcstats/rtcstats-shared';
import { computeConnectionMos, selectActiveCandidatePair, type StatsTimeSeries } from '@rtcstats-dashboard/mos';
import type { TraceEvent } from './dumpTypes.js';

/** A `[timestamp, value]` pair as emitted by `createRtcStatsTimeSeries`. */
type RawPoint = [number, unknown];
type Point = [number, number];

/** One stats object's properties over time, plus its `RTCStatsType`. */
interface StatsObject {
  type?: string;
  [property: string]: unknown;
}

export interface ChartSeries {
  label: string;
  /** Aligned to `ConnectionSeries.x`; `null` where the stream had no sample. */
  values: (number | null)[];
  /**
   * Index into the categorical series palette. Fixed per entity (outbound video is
   * always the same colour) so that a chart losing a series never repaints the rest.
   */
  colorSlot: number;
}

export interface ChartSpec {
  key: string;
  title: string;
  /** Y-axis label. Every chart has exactly one scale, so every series shares it. */
  unit: string;
  /** Fixed y range for bounded measures; otherwise the axis runs from 0 to the data. */
  range?: [number, number];
  series: ChartSeries[];
}

export interface ConnectionSeries {
  /** Seconds since the connection's first stats sample. */
  x: number[];
  /** Epoch ms of `x[0]`, so the chart can be related back to wall-clock time. */
  startTime: number;
  charts: ChartSpec[];
}

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
 * Differentiate a monotonically increasing counter into a per-second rate.
 *
 * `bytesSent`, `packetsLost` and friends are cumulative totals, so plotting them raw
 * yields a meaningless ever-rising line. A negative delta means the counter was reset
 * (renegotiation, ssrc change) rather than that traffic went backwards, so it clamps to 0.
 */
function toRate(counter: Point[]): Point[] {
  const rates: Point[] = [];
  for (let i = 1; i < counter.length; i++) {
    const seconds = (counter[i][0] - counter[i - 1][0]) / 1000;
    if (seconds <= 0) continue;
    const delta = counter[i][1] - counter[i - 1][1];
    rates.push([counter[i][0], delta >= 0 ? delta / seconds : 0]);
  }
  return rates;
}

function scaleBy(series: Point[], factor: number): Point[] {
  return series.map(([t, v]) => [t, v * factor] as Point);
}

function alignTo(timestamps: number[], series: Point[]): (number | null)[] {
  const byTimestamp = new Map(series);
  return timestamps.map((t) => byTimestamp.get(t) ?? null);
}

/** Element-wise sum, treating `null` as "no sample" so it never drags a total to zero. */
function sumAligned(columns: (number | null)[][]): (number | null)[] {
  if (columns.length === 0) return [];
  return columns[0].map((_, i) => {
    let total: number | null = null;
    for (const column of columns) {
      const value = column[i];
      if (value != null) total = (total ?? 0) + value;
    }
    return total;
  });
}

function hasAnyValue(values: (number | null)[]): boolean {
  return values.some((v) => v != null);
}

function statsOfType(stats: Record<string, StatsObject>, type: string): StatsObject[] {
  return Object.values(stats).filter((s) => s.type === type);
}

function ofKind(objects: StatsObject[], kind: string): StatsObject[] {
  return objects.filter((s) => firstValue(s.kind) === kind || lastValue(s.kind) === kind);
}

/** The stream with the most samples of `property` — i.e. the one actually flowing. */
function busiest(objects: StatsObject[], property: string): StatsObject | null {
  let best: StatsObject | null = null;
  let bestCount = 0;
  for (const object of objects) {
    const count = numeric(object[property]).length;
    if (count > bestCount) {
      best = object;
      bestCount = count;
    }
  }
  return best;
}

interface SeriesDraft {
  label: string;
  colorSlot: number;
  data: Point[];
}

/**
 * Fixed palette slot per entity, so a series keeps its colour across every chart it
 * appears in and a chart that loses a series never repaints the survivors.
 *
 * The assignment is also what keeps the palette accessible: `aggregate` (yellow) and
 * `inboundAudio` (green) are the one pair that only reaches the 6-8 CVD floor band in
 * dark mode, so the charts below are arranged so those two never appear together —
 * which is why round-trip time and jitter are separate charts rather than one.
 */
const SLOT = {
  outbound: 0,
  aggregate: 1,
  inboundVideo: 2,
  inboundAudio: 3
} as const;

function collectTimestamps(drafts: SeriesDraft[]): number[] {
  const all = new Set<number>();
  for (const draft of drafts) {
    for (const [t] of draft.data) all.add(t);
  }
  return [...all].sort((a, b) => a - b);
}

/**
 * Build the chart data for one peer connection's trace.
 *
 * Returns null when the trace holds no chartable stats, which the caller renders as an
 * explicit empty state rather than an empty plot frame.
 */
export function buildConnectionSeries(trace: TraceEvent[] | undefined): ConnectionSeries | null {
  if (!trace || trace.length === 0) return null;

  const stats = createRtcStatsTimeSeries(trace) as Record<string, StatsObject>;

  const outbound = statsOfType(stats, 'outbound-rtp');
  const inbound = statsOfType(stats, 'inbound-rtp');
  const pair = selectActiveCandidatePair(stats);

  // Bitrate: sum every stream of the same direction and kind, since simulcast splits one
  // logical video feed across several outbound-rtp objects.
  const bitrate: Record<'audio' | 'video', SeriesDraft[]> = { audio: [], video: [] };
  for (const [direction, objects, counter] of [
    ['Outbound', outbound, 'bytesSent'],
    ['Inbound', inbound, 'bytesReceived']
  ] as const) {
    for (const kind of ['audio', 'video'] as const) {
      const streams = ofKind(objects, kind);
      if (streams.length === 0) continue;
      const rates = streams.map((stream) => scaleBy(toRate(numeric(stream[counter])), 8));
      const timestamps = collectTimestamps(rates.map((data) => ({ label: '', colorSlot: 0, data })));
      if (timestamps.length === 0) continue;
      const summed = sumAligned(rates.map((rate) => alignTo(timestamps, rate)));
      bitrate[kind].push({
        label: `${direction} ${kind}`,
        colorSlot: direction === 'Outbound'
          ? SLOT.outbound
          : kind === 'video' ? SLOT.inboundVideo : SLOT.inboundAudio,
        data: timestamps.map((t, i) => [t, summed[i] ?? 0] as Point)
      });
    }
  }

  // Available outgoing bandwidth shares the bits/s axis with the video bitrate it
  // constrains, which is the comparison worth making: how much headroom was left.
  // Audio is a separate chart because ~30 kbps is invisible on a megabit axis.
  if (pair) {
    const available = numeric(pair.availableOutgoingBitrate);
    if (available.length > 0) {
      bitrate.video.push({ label: 'Available outgoing', colorSlot: SLOT.aggregate, data: available });
    }
  }

  const rttDrafts: SeriesDraft[] = [];
  if (pair) {
    const rtt = scaleBy(numeric(pair.currentRoundTripTime), 1000);
    if (rtt.length > 0) rttDrafts.push({ label: 'Round-trip time', colorSlot: SLOT.aggregate, data: rtt });
  }

  const jitterDrafts: SeriesDraft[] = [];
  for (const kind of ['audio', 'video'] as const) {
    const stream = busiest(ofKind(inbound, kind), 'jitter');
    if (!stream) continue;
    // Jitter is reported in seconds; milliseconds is the readable unit.
    const jitter = scaleBy(numeric(stream.jitter), 1000);
    if (jitter.length === 0) continue;
    jitterDrafts.push({
      label: kind === 'audio' ? 'Inbound audio' : 'Inbound video',
      colorSlot: kind === 'audio' ? SLOT.inboundAudio : SLOT.inboundVideo,
      data: jitter
    });
  }

  const lossDrafts: SeriesDraft[] = [];
  if (inbound.length > 0) {
    const lossRates = inbound.map((stream) => toRate(numeric(stream.packetsLost)));
    const timestamps = collectTimestamps(lossRates.map((data) => ({ label: '', colorSlot: 0, data })));
    if (timestamps.length > 0) {
      const summed = sumAligned(lossRates.map((rate) => alignTo(timestamps, rate)));
      lossDrafts.push({
        label: 'Packet loss',
        colorSlot: SLOT.aggregate,
        data: timestamps.map((t, i) => [t, summed[i] ?? 0] as Point)
      });
    }
  }

  const frameRateDrafts: SeriesDraft[] = [];
  const resolutionDrafts: SeriesDraft[] = [];
  for (const [direction, objects] of [['Outbound', outbound], ['Inbound', inbound]] as const) {
    const slot = direction === 'Outbound' ? SLOT.outbound : SLOT.inboundVideo;
    const videoStreams = ofKind(objects, 'video');

    // Prefer the reported framesPerSecond; derive it from framesDecoded where the browser
    // did not report it (it is absent on streams that never rendered).
    const reported = busiest(videoStreams, 'framesPerSecond');
    const frameRate = reported
      ? numeric(reported.framesPerSecond)
      : toRate(numeric(busiest(videoStreams, 'framesDecoded')?.framesDecoded));
    if (frameRate.length > 0) {
      frameRateDrafts.push({ label: `${direction} video`, colorSlot: slot, data: frameRate });
    }

    const height = numeric(busiest(videoStreams, 'frameHeight')?.frameHeight);
    if (height.length > 0) {
      resolutionDrafts.push({ label: `${direction} video`, colorSlot: slot, data: height });
    }
  }

  // MOS of what this connection received: the E-model for audio, P.1203.1 for video.
  // Computed by the same code the analyzer uses for the call's stored MOS.
  const mos = computeConnectionMos(stats as StatsTimeSeries);
  const mosDrafts: SeriesDraft[] = [];
  if (mos.audio.length > 0) {
    mosDrafts.push({ label: 'Inbound audio', colorSlot: SLOT.inboundAudio, data: mos.audio.map((s) => [s.t, s.mos]) });
  }
  if (mos.video.length > 0) {
    mosDrafts.push({ label: 'Inbound video', colorSlot: SLOT.inboundVideo, data: mos.video.map((s) => [s.t, s.mos]) });
  }

  const freezeDrafts: SeriesDraft[] = [];
  const freezes = numeric(busiest(inbound, 'freezeCount')?.freezeCount);
  if (freezes.length > 0) {
    freezeDrafts.push({ label: 'Freezes', colorSlot: SLOT.inboundVideo, data: freezes });
  }

  // One chart per unit. Two measures of different scale never share a y axis: a second
  // axis silently rescales one series against the other and invites false correlations.
  const specs: { key: string; title: string; unit: string; range?: [number, number]; drafts: SeriesDraft[] }[] = [
    { key: 'mos', title: 'Mean opinion score (received)', unit: 'MOS (1–5)', range: [1, 5], drafts: mosDrafts },
    { key: 'video-bitrate', title: 'Video bitrate & available bandwidth', unit: 'bits/s', drafts: bitrate.video },
    { key: 'audio-bitrate', title: 'Audio bitrate', unit: 'bits/s', drafts: bitrate.audio },
    { key: 'rtt', title: 'Round-trip time', unit: 'ms', drafts: rttDrafts },
    { key: 'jitter', title: 'Jitter', unit: 'ms', drafts: jitterDrafts },
    { key: 'loss', title: 'Packet loss', unit: 'lost/s', drafts: lossDrafts },
    { key: 'framerate', title: 'Frame rate', unit: 'frames/s', drafts: frameRateDrafts },
    { key: 'resolution', title: 'Video resolution', unit: 'height (px)', drafts: resolutionDrafts },
    { key: 'freezes', title: 'Video freezes', unit: 'freezes (cumulative)', drafts: freezeDrafts }
  ];

  // One shared x axis across every chart so their cursors can be synced.
  const timestamps = collectTimestamps(specs.flatMap((spec) => spec.drafts));
  if (timestamps.length === 0) return null;

  const startTime = timestamps[0];
  const charts: ChartSpec[] = [];
  for (const spec of specs) {
    const series = spec.drafts
      .map((draft) => ({
        label: draft.label,
        colorSlot: draft.colorSlot,
        values: alignTo(timestamps, draft.data)
      }))
      .filter((entry) => hasAnyValue(entry.values));
    if (series.length === 0) continue;
    charts.push({ key: spec.key, title: spec.title, unit: spec.unit, ...(spec.range && { range: spec.range }), series });
  }

  if (charts.length === 0) return null;

  return {
    x: timestamps.map((t) => (t - startTime) / 1000),
    startTime,
    charts
  };
}
