import type { Observation } from '../lib/api.js';

type MessageFn = (o: Observation) => string;

function fmtSeconds(ms: unknown): string {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : String(ms);
}

function fmtPercent(value: unknown): string {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : String(value);
}

export const observationMessages: Record<string, MessageFn> = {
  'connectivity.never_connected': () => 'This connection never established ICE connectivity.',
  'connectivity.slow_ice_connect': (o) => `ICE took ${fmtSeconds(o.observation.iceConnectionTime)} to connect.`,
  'connectivity.slow_turn_gathering': (o) => `Gathering TURN candidates took ${fmtSeconds(o.observation.worst)}.`,
  'connectivity.ice_restart': () => 'The connection performed an ICE restart.',
  'connectivity.ice_restart_followed_by_srd': () => 'An ICE restart raced a setRemoteDescription call.',
  'connectivity.null_candidate_added': () => 'End-of-candidates was signaled.',
  'connectivity.relay_only_path': (o) => `Traffic was routed through a relay (${String(o.observation.localType)}).`,
  'connectivity.dtls_handshake_incomplete': () => 'The connection reported connected without a completed DTLS handshake.',
  'connectivity.clock_skew': (o) => `Clock skew of ${o.observation.clockSkew}ms was detected.`,
  'connectivity.signaling_delay': (o) => `Signaling was delayed by ${fmtSeconds(o.observation.signalingDelay)}.`,
  'connectivity.slow_set_remote_description': (o) => `setRemoteDescription took ${fmtSeconds(o.observation.delay)}.`,
  'connectivity.slow_set_local_description': (o) => `setLocalDescription took ${fmtSeconds(o.observation.delay)}.`,
  'video.freezes': (o) => `Video froze ${o.observation.count} times, totaling ${fmtSeconds(o.observation.totalFreezesDuration)}.`,
  'video.quality_limitation_cpu': (o) => `Video was CPU-limited ${fmtPercent(o.observation.percentage)} of the time.`,
  'video.quality_limitation_bandwidth': (o) => `Video was bandwidth-limited ${fmtPercent(o.observation.percentage)} of the time.`,
  'video.frequent_resolution_changes': (o) => `Video resolution changed ${o.observation.count} times.`,
  'video.slow_time_to_first_frame': (o) => `The first video frame took ${fmtSeconds(o.observation.timeToFirstFrame)} to arrive.`,
  'video.slow_encode': (o) => `Average encode time was ${o.observation.averageEncodeTime}ms.`,
  'video.slow_decode': (o) => `Average decode time was ${o.observation.averageDecodeTime}ms.`,
  'video.no_hw_acceleration': (o) => `Video decoding used software (${String(o.observation.decoderImplementation)}), not hardware acceleration.`,
  'video.null_video_decoder': () => 'The video decoder reported as null — decoding was broken.',
  'video.qp_degradation': (o) => `Average QP reached ${Math.round(Number(o.observation.averageQp))}, indicating heavy compression.`,
  'audio.concealment_ratio': (o) => `${fmtPercent(o.observation.percentage)} of audio samples were concealed (packet loss).`,
  'audio.jitter_buffer_flushes': (o) => o.observation.periodic
    ? 'The jitter buffer flushed periodically.'
    : `The jitter buffer flushed ${o.observation.count} times.`,
  'audio.time_stretching': (o) => `Audio was time-stretched by ${fmtPercent(o.observation.percentage)}.`,
  'audio.track_ended_unexpectedly': () => 'The audio track ended shortly after starting.',
  'device.get_user_media_failure': (o) => `getUserMedia failed (${String(o.observation.error ?? 'unknown error')}).`,
  'device.low_cpu_performance': (o) => `Device CPU performance was rated low (${o.observation.cpuPerformance}).`,
  'device.frequent_reloads': (o) => `The page reloaded ${o.observation.reloadCount} times during the call.`,
  'api.add_ice_candidate_failure': (o) => `addIceCandidate failed: ${String(o.observation.error)}.`,
  'api.set_local_description_failure': (o) => `setLocalDescription failed: ${String(o.observation.error)}.`,
  'api.set_remote_description_failure': (o) => `setRemoteDescription failed: ${String(o.observation.error)}.`
};

export function describeObservation(observation: Observation): string {
  const template = observationMessages[observation.type];
  return template ? template(observation) : `Unrecognized observation: ${observation.type}`;
}
