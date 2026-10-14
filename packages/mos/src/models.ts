/**
 * Objective MOS models.
 *
 * Both models estimate a mean opinion score on the usual 1–5 scale from network and
 * media measurements alone; neither looks at the decoded audio or pixels. They are
 * estimates for comparing calls with each other, not a substitute for a listening test.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── Audio: ITU-T G.107 E-model ─────────────────────────────────────────────────

/** Default R-factor with every impairment at its G.107 default. */
const R0 = 93.2;

/**
 * Opus packetisation (20 ms frame) plus its 6.5 ms lookahead: the delay the codec adds
 * on top of the network and the jitter buffer.
 */
export const OPUS_ALGORITHMIC_DELAY_MS = 26.5;

/**
 * Equipment impairment of the codec and its robustness to packet loss (G.113 terms).
 *
 * G.113 has no entry for Opus. Opus is transparent at WebRTC bitrates (Ie = 0) and
 * ships packet loss concealment, so it borrows the loss robustness G.113 Appendix I
 * gives G.711 with PLC (Bpl = 25.1).
 */
export const OPUS_IE = 0;
export const OPUS_BPL = 25.1;

export interface AudioMosInput {
  /** Round-trip time of the transport, in ms. */
  rttMs: number;
  /** Inter-arrival jitter as reported by the receiver, in ms. */
  jitterMs: number;
  /**
   * Average time a sample spent in the jitter buffer, in ms. When known it replaces the
   * `2 × jitter` estimate, because it is the delay the listener actually experienced.
   */
  jitterBufferDelayMs?: number | null;
  /** Packets lost over packets expected, in percent (0–100). */
  packetLossPct: number;
}

/** G.107 delay impairment `Id` for a one-way mouth-to-ear delay in ms. */
function delayImpairment(oneWayDelayMs: number): number {
  const excess = oneWayDelayMs - 177.3;
  return 0.024 * oneWayDelayMs + (excess > 0 ? 0.11 * excess : 0);
}

/** G.107 effective equipment impairment `Ie,eff` under random packet loss. */
function equipmentImpairment(packetLossPct: number, ie = OPUS_IE, bpl = OPUS_BPL): number {
  const loss = clamp(packetLossPct, 0, 100);
  return ie + (95 - ie) * (loss / (loss + bpl));
}

/** G.107 Annex B conversion from the transmission rating R to MOS (1–4.5). */
export function mosFromRating(r: number): number {
  if (r <= 0) return 1;
  if (r >= 100) return 4.5;
  return 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6;
}

export function audioRating(input: AudioMosInput): number {
  const bufferMs = input.jitterBufferDelayMs ?? 2 * Math.max(0, input.jitterMs);
  const oneWayDelayMs = Math.max(0, input.rttMs) / 2 + Math.max(0, bufferMs) + OPUS_ALGORITHMIC_DELAY_MS;
  return R0 - delayImpairment(oneWayDelayMs) - equipmentImpairment(input.packetLossPct);
}

export function audioMos(input: AudioMosInput): number {
  return mosFromRating(audioRating(input));
}

// ─── Video: ITU-T P.1203.1 mode 0 ───────────────────────────────────────────────

/** P.1203 maps its quality scale onto [MOS_MIN, MOS_MAX] rather than G.107's [1, 4.5]. */
const P1203_MOS_MIN = 1.05;
const P1203_MOS_MAX = 4.9;

/** P.1203 conversion from the 0–100 quality scale to MOS. */
export function p1203MosFromQuality(q: number): number {
  if (q <= 0) return P1203_MOS_MIN;
  if (q >= 100) return P1203_MOS_MAX;
  return P1203_MOS_MIN + ((P1203_MOS_MAX - P1203_MOS_MIN) * q) / 100 + q * (q - 60) * (100 - q) * 7e-6;
}

/** Inverse of `p1203MosFromQuality`, which is monotonic on [0, 100]. */
export function p1203QualityFromMos(mos: number): number {
  const target = clamp(mos, P1203_MOS_MIN, P1203_MOS_MAX);
  let low = 0;
  let high = 100;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (p1203MosFromQuality(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Bitrate multiplier relative to H.264, the codec P.1203.1 was trained on.
 *
 * A heuristic, not part of the standard: newer codecs reach the same quality with fewer
 * bits, so their bitrate is scaled up before the H.264-trained curve is applied.
 */
export const CODEC_EFFICIENCY: Record<string, number> = {
  h264: 1,
  vp8: 1,
  vp9: 1.3,
  h265: 1.3,
  av1: 1.5
};

export function codecEfficiency(mimeType: string | null | undefined): number {
  const codec = mimeType?.toLowerCase().replace(/^video\//, '');
  return (codec ? CODEC_EFFICIENCY[codec] : undefined) ?? 1;
}

export interface VideoMosInput {
  /** Received video bitrate, in kbit/s. */
  bitrateKbps: number;
  /** Decoded frame rate, in frames/s. */
  frameRate: number;
  frameWidth: number;
  frameHeight: number;
  /** Fraction of the interval the video was frozen (0–1). */
  freezeRatio?: number;
  /** e.g. `video/VP8`; unknown codecs are treated like H.264. */
  mimeType?: string | null;
}

/**
 * P.1203.1 mode 0 short-term video quality, extended with a freeze penalty.
 *
 * Mode 0 only needs bitrate, resolution and frame rate, which is exactly what WebRTC's
 * inbound-rtp stats provide. The display size is unknown, so no upscaling degradation
 * is applied. Mode 0 has no notion of a stalled picture, so frozen time pulls the score
 * linearly towards 1: a picture frozen half the time keeps half its headroom above 1.
 */
export function videoMos(input: VideoMosInput): number {
  const codingRes = input.frameWidth * input.frameHeight;
  if (!(codingRes > 0) || !(input.frameRate > 0)) return 1;

  const bitrate = Math.max(1, input.bitrateKbps * codecEfficiency(input.mimeType));
  const frameRate = input.frameRate;

  const quant =
    11.9983519 +
    -2.99991847 * Math.log(41.2475074001 + Math.log(bitrate) + Math.log((bitrate * bitrate) / (codingRes * frameRate) + 0.13183165961));
  const mosCoding = clamp(4.66 + -0.07 * Math.exp(4.06 * quant), 1, 5);
  const codingDegradation = clamp(100 - p1203QualityFromMos(mosCoding), 0, 100);

  const frameRateDegradation = frameRate < 24
    ? clamp(((100 - codingDegradation) * (30.98 - 1.29 * frameRate)) / (64.65 + frameRate), 0, 100)
    : 0;

  const quality = 100 - clamp(codingDegradation + frameRateDegradation, 0, 100);
  const mos = p1203MosFromQuality(quality);

  const frozen = clamp(input.freezeRatio ?? 0, 0, 1);
  return 1 + (mos - 1) * (1 - frozen);
}
