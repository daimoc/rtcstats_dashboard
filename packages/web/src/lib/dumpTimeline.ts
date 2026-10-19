import { PAGE_LEVEL_PC_ID, type DecodedDump, type TraceEvent } from './dumpTypes.js';

export type EventSeverity = 'critical' | 'warning' | 'info';

export interface TimelineEvent {
  timestamp: number;
  type: string;
  severity: EventSeverity;
  label: string;
  details?: string;
  /** Dump-side connection id (`PC_0`), or `null` for page-level events. */
  pcId: string;
}

/**
 * Methods that fire too often to read as a timeline. `getStats` alone is ~96% of a
 * dump's events and is chart data rather than timeline data; the rest are per-candidate
 * or per-encoding chatter that would bury the events that actually explain a call.
 */
const NOISY_METHODS = new Set([
  'getStats',
  'onicecandidate',
  'addIceCandidate',
  'addIceCandidateOnSuccess',
  'setParameters',
  'setCodecPreferences',
  'navigator.mediaDevices.enumerateDevices'
]);

/** ICE/connection/signaling states that are worth flagging rather than just recording. */
const STATE_SEVERITY: Record<string, EventSeverity> = {
  failed: 'critical',
  disconnected: 'warning',
  closed: 'warning'
};

const FAILURE_SUFFIX = 'OnFailure';

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function trackFromValue(value: unknown): { kind: string; label: string | null } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const kind = asString(value[0]) ?? 'unknown';
  // ontrack is [kind, trackId, streamId, label]; addTrack is [kind, trackId, label].
  const label = asString(value[value.length - 1]);
  return { kind, label: label && label !== value[1] ? label : null };
}

/**
 * Turn one decoded trace event into a timeline entry, or null to drop it.
 *
 * `pcId` matters for disambiguation: the dump reuses the `close` method for both a
 * peer connection closing and the signaling websocket closing, telling them apart only
 * by whether the event belongs to a connection.
 */
function describe(event: TraceEvent, pcId: string): Omit<TimelineEvent, 'timestamp' | 'pcId'> | null {
  const { type, value, extra } = event;
  if (NOISY_METHODS.has(type)) return null;

  const base = { type, severity: 'info' as EventSeverity };

  if (type.endsWith(FAILURE_SUFFIX)) {
    const operation = type.slice(0, -FAILURE_SUFFIX.length);
    return {
      ...base,
      severity: 'critical',
      label: `${operation} failed`,
      details: asString(value) ?? JSON.stringify(value)
    };
  }

  switch (type) {
    case 'create':
      return pcId === PAGE_LEVEL_PC_ID
        ? { ...base, label: 'Session started' }
        : { ...base, label: 'Peer connection created' };

    case 'close':
      return pcId === PAGE_LEVEL_PC_ID
        ? { ...base, label: 'Signaling websocket closed', details: `code ${String(value)}` }
        : { ...base, label: 'Peer connection closed' };

    case 'websocket':
      return { ...base, label: 'Signaling websocket connected' };

    case 'oniceconnectionstatechange':
    case 'onconnectionstatechange':
    case 'onsignalingstatechange':
    case 'onicegatheringstatechange': {
      const state = asString(value) ?? 'unknown';
      const subject = type === 'oniceconnectionstatechange' ? 'ICE connection'
        : type === 'onconnectionstatechange' ? 'Connection'
        : type === 'onsignalingstatechange' ? 'Signaling'
        : 'ICE gathering';
      return { ...base, severity: STATE_SEVERITY[state] ?? 'info', label: `${subject}: ${state}` };
    }

    case 'onicecandidateerror': {
      const error = value as { errorCode?: number; errorText?: string; url?: string } | null;
      return {
        ...base,
        severity: 'warning',
        label: 'ICE candidate error',
        details: [error?.errorText, error?.url].filter(Boolean).join(' · ') || undefined
      };
    }

    case 'restartIce':
      return { ...base, severity: 'warning', label: 'ICE restart requested' };

    case 'ontrack':
    case 'addTrack': {
      const track = trackFromValue(value);
      const direction = type === 'ontrack' ? 'Remote' : 'Local';
      return {
        ...base,
        label: `${direction} ${track?.kind ?? 'unknown'} track added`,
        details: track?.label ?? undefined
      };
    }

    case 'addTransceiver': {
      // [track, init]: the track is [kind, trackId, label] when one is attached (how
      // LiveKit publishes), or a bare kind string for a receive-only transceiver.
      const [trackOrKind, init] = Array.isArray(value) ? value : [];
      const direction = asString((init as { direction?: unknown } | null)?.direction) ?? 'sendrecv';
      if (Array.isArray(trackOrKind)) {
        const track = trackFromValue(trackOrKind);
        return {
          ...base,
          label: `Local ${track?.kind ?? 'unknown'} track added (${direction})`,
          details: track?.label ?? undefined
        };
      }
      return { ...base, label: `${asString(trackOrKind) ?? 'Media'} transceiver added (${direction})` };
    }

    case 'removeTrack':
      return { ...base, label: 'Track removed' };

    case 'MediaStreamTrack.onmute':
      return { ...base, severity: 'warning', label: 'Track muted' };

    case 'MediaStreamTrack.onunmute':
      return { ...base, label: 'Track unmuted' };

    case 'MediaStreamTrack.onended':
      return { ...base, severity: 'warning', label: 'Track ended' };

    case 'MediaStreamTrack.stop':
      return { ...base, label: 'Track stopped' };

    case 'HTMLMediaElement.resize': {
      const size = value as { videoWidth?: number; videoHeight?: number } | null;
      const element = asString(extra[0]);
      return {
        ...base,
        label: `Video resized to ${size?.videoWidth ?? '?'}×${size?.videoHeight ?? '?'}`,
        details: element ?? undefined
      };
    }

    case 'navigator.mediaDevices.getUserMedia':
      return { ...base, label: 'Camera/microphone requested' };

    case 'navigator.mediaDevices.getUserMediaOnSuccess': {
      const devices = Array.isArray(value) ? value : [];
      const names = devices
        .map((d) => (Array.isArray(d) ? asString(d[2]) : null))
        .filter((name): name is string => Boolean(name));
      return { ...base, label: 'Camera/microphone granted', details: names.join(', ') || undefined };
    }

    case 'navigator.mediaDevices.getDisplayMedia':
      return { ...base, label: 'Screen share requested' };

    case 'createDataChannel': {
      const label = Array.isArray(value) ? asString(value[0]) : null;
      return { ...base, label: 'Data channel created', details: label ?? undefined };
    }

    case 'createOffer':
    case 'createAnswer':
    case 'setLocalDescription':
    case 'setRemoteDescription':
      return { ...base, label: type };

    default:
      // Success callbacks and anything unrecognised are recorded but not dressed up;
      // an unknown method is still a real event that happened at a real time.
      return { ...base, label: type };
  }
}

/**
 * Build a chronological timeline for the whole session.
 *
 * Every event carries an absolute timestamp reconstructed by the decoder, so unlike the
 * previous feature-derived implementation there is nothing to filter out for want of a
 * time — the only events dropped are the deliberately noisy ones.
 */
export function buildTimeline(dump: DecodedDump | null): TimelineEvent[] {
  if (!dump?.peerConnections) return [];

  const events: TimelineEvent[] = [];
  for (const [pcId, trace] of Object.entries(dump.peerConnections)) {
    for (const event of trace) {
      const described = describe(event, pcId);
      if (described) events.push({ ...described, timestamp: event.timestamp, pcId });
    }
  }

  return events.sort((a, b) => a.timestamp - b.timestamp);
}
