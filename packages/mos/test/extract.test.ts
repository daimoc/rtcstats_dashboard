import { describe, expect, it } from 'vitest';
import { computeConnectionMos, type StatsTimeSeries } from '../src/extract.js';
import { summarize } from '../src/dump.js';

/** One property sampled once a second, starting at t = 0. */
function series(values: unknown[]): [number, unknown][] {
  return values.map((value, i) => [i * 1000, value]);
}

function cumulative(perSecond: number[]): number[] {
  let total = 0;
  return [0, ...perSecond.map((v) => (total += v))];
}

function audioStream(lostPerSecond: number[]): Record<string, unknown> {
  const n = lostPerSecond.length + 1;
  return {
    type: 'inbound-rtp',
    kind: series(Array(n).fill('audio')),
    bytesReceived: series(cumulative(Array(n - 1).fill(4000))),
    packetsReceived: series(cumulative(lostPerSecond.map((lost) => 50 - lost))),
    packetsLost: series(cumulative(lostPerSecond)),
    jitter: series(Array(n).fill(0.005))
  };
}

function videoStream(framesPerSecond: number[], bytesPerSecond = 190_000): Record<string, unknown> {
  const n = framesPerSecond.length + 1;
  return {
    type: 'inbound-rtp',
    kind: series(Array(n).fill('video')),
    codecId: series(Array(n).fill('c1')),
    bytesReceived: series(cumulative(Array(n - 1).fill(bytesPerSecond))),
    framesDecoded: series(cumulative(framesPerSecond)),
    frameWidth: series(Array(n).fill(1280)),
    frameHeight: series(Array(n).fill(720)),
    totalFreezesDuration: series(Array(n).fill(0))
  };
}

describe('computeConnectionMos', () => {
  it('scores one sample per stats interval', () => {
    const stats: StatsTimeSeries = { a: audioStream([0, 0, 0]) };
    const mos = computeConnectionMos(stats);
    expect(mos.audio).toHaveLength(3);
    expect(mos.audio.every((s) => s.seconds === 1 && s.mos > 4.3)).toBe(true);
    expect(mos.video).toEqual([]);
  });

  it('lowers audio MOS in the intervals that lost packets', () => {
    const mos = computeConnectionMos({ a: audioStream([0, 10, 0]) });
    expect(mos.audio[1].mos).toBeLessThan(mos.audio[0].mos - 1);
    expect(mos.audio[2].mos).toBeCloseTo(mos.audio[0].mos, 6);
  });

  it('uses the active candidate pair round-trip time', () => {
    const near = computeConnectionMos({ a: audioStream([0]) }).audio[0].mos;
    const far = computeConnectionMos({
      a: audioStream([0]),
      p: { type: 'candidate-pair', nominated: series([true, true]), currentRoundTripTime: series([0.8, 0.8]) }
    }).audio[0].mos;
    expect(far).toBeLessThan(near);
  });

  it('skips intervals where nothing was received', () => {
    const stream = audioStream([0, 0]);
    stream.packetsReceived = series([0, 50, 50]);
    expect(computeConnectionMos({ a: stream }).audio).toHaveLength(1);
  });

  it('scores a picture that receives packets but decodes nothing as frozen', () => {
    const mos = computeConnectionMos({
      v: videoStream([30, 0, 30]),
      c1: { type: 'codec', mimeType: series(['video/VP8']) }
    });
    expect(mos.video.map((s) => s.mos)).toEqual([expect.any(Number), 1, expect.any(Number)]);
    expect(mos.video[0].mos).toBeGreaterThan(4);
  });

  it('averages concurrent streams of the same kind', () => {
    const good = computeConnectionMos({ v: videoStream([30, 30]) }).video;
    const poor = computeConnectionMos({ v: videoStream([30, 30], 5_000) }).video;
    const both = computeConnectionMos({ v1: videoStream([30, 30]), v2: videoStream([30, 30], 5_000) }).video;
    expect(both).toHaveLength(2);
    expect(both[0].mos).toBeCloseTo((good[0].mos + poor[0].mos) / 2, 6);
  });
});

describe('summarize', () => {
  it('weights samples by the interval they cover', () => {
    const stats = summarize([
      { t: 1, mos: 4, seconds: 3 },
      { t: 2, mos: 2, seconds: 1 }
    ]);
    expect(stats).toEqual({ mean: 3.5, min: 2, seconds: 4 });
  });

  it('returns null when nothing was scored', () => {
    expect(summarize([])).toBeNull();
  });
});
