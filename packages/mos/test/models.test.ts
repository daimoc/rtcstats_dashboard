import { describe, expect, it } from 'vitest';
import {
  audioMos,
  codecEfficiency,
  mosFromRating,
  p1203MosFromQuality,
  p1203QualityFromMos,
  videoMos
} from '../src/models.js';

const clean = { rttMs: 0, jitterMs: 0, packetLossPct: 0 };
const hd = { bitrateKbps: 1500, frameRate: 30, frameWidth: 1280, frameHeight: 720 };

describe('mosFromRating (G.107)', () => {
  it('bounds the scale at 1 and 4.5', () => {
    expect(mosFromRating(-10)).toBe(1);
    expect(mosFromRating(120)).toBe(4.5);
  });

  it('maps the default rating to toll quality', () => {
    expect(mosFromRating(93.2)).toBeCloseTo(4.41, 2);
  });
});

describe('audioMos', () => {
  it('scores a clean network near the top of the scale', () => {
    const mos = audioMos(clean);
    expect(mos).toBeGreaterThan(4.3);
    expect(mos).toBeLessThanOrEqual(4.5);
  });

  it('drops monotonically with packet loss', () => {
    const scores = [0, 1, 5, 10, 20].map((packetLossPct) => audioMos({ ...clean, packetLossPct }));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
    expect(audioMos({ ...clean, packetLossPct: 20 })).toBeLessThan(3);
  });

  it('penalises delay past the G.107 177.3 ms knee much harder', () => {
    const below = audioMos({ ...clean, rttMs: 200 }) - audioMos({ ...clean, rttMs: 300 });
    const above = audioMos({ ...clean, rttMs: 500 }) - audioMos({ ...clean, rttMs: 600 });
    expect(above).toBeGreaterThan(below);
  });

  it('prefers the measured jitter buffer delay over the 2x jitter estimate', () => {
    const estimated = audioMos({ ...clean, jitterMs: 100 });
    const measured = audioMos({ ...clean, jitterMs: 100, jitterBufferDelayMs: 20 });
    expect(measured).toBeGreaterThan(estimated);
  });
});

describe('P.1203 quality scale', () => {
  it('inverts its own MOS mapping', () => {
    for (const q of [5, 30, 60, 90]) {
      expect(p1203QualityFromMos(p1203MosFromQuality(q))).toBeCloseTo(q, 3);
    }
  });
});

describe('videoMos (P.1203.1 mode 0)', () => {
  it('scores 720p30 at 1.5 Mbit/s H.264 as good', () => {
    const mos = videoMos(hd);
    expect(mos).toBeGreaterThan(4);
    expect(mos).toBeLessThan(4.9);
  });

  it('rises with bitrate', () => {
    const scores = [100, 300, 800, 2500].map((bitrateKbps) => videoMos({ ...hd, bitrateKbps }));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThan(scores[i - 1]);
  });

  it('penalises frame rates below 24 fps only', () => {
    expect(videoMos({ ...hd, frameRate: 24 })).toBeGreaterThan(videoMos({ ...hd, frameRate: 10 }));
    expect(videoMos({ ...hd, frameRate: 10 })).toBeGreaterThan(videoMos({ ...hd, frameRate: 3 }));
  });

  it('pulls a frozen picture to 1', () => {
    expect(videoMos({ ...hd, freezeRatio: 1 })).toBe(1);
    const half = videoMos({ ...hd, freezeRatio: 0.5 });
    expect(half).toBeCloseTo(1 + (videoMos(hd) - 1) / 2, 6);
  });

  it('credits more efficient codecs with more quality per bit', () => {
    expect(codecEfficiency('video/AV1')).toBeGreaterThan(1);
    expect(codecEfficiency('video/unknown')).toBe(1);
    expect(videoMos({ ...hd, bitrateKbps: 300, mimeType: 'video/AV1' }))
      .toBeGreaterThan(videoMos({ ...hd, bitrateKbps: 300, mimeType: 'video/H264' }));
  });

  it('scores a stream without a picture as 1', () => {
    expect(videoMos({ ...hd, frameWidth: 0 })).toBe(1);
    expect(videoMos({ ...hd, frameRate: 0 })).toBe(1);
  });
});
