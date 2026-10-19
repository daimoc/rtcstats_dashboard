import { buildTimeline, type TimelineEvent } from './dumpTimeline.js';
import { PAGE_LEVEL_PC_ID, type DecodedDump, type TraceEvent } from './dumpTypes.js';

/** How a state reads at a glance; drives the segment colour. */
export type StateTone = 'good' | 'pending' | 'bad' | 'closed';

export interface StateSegment {
  state: string;
  tone: StateTone;
  /** Epoch ms. */
  from: number;
  to: number;
}

export interface StateLane {
  key: 'connection' | 'ice' | 'signaling' | 'gathering';
  label: string;
  segments: StateSegment[];
}

export interface Milestone {
  label: string;
  at: number;
}

/** Durations in ms; null when the connection never reached the end state. */
export interface ConnectionTimings {
  /** `create` → first `connectionState: connected`. */
  timeToConnected: number | null;
  /** First ICE `checking` → first ICE `connected`/`completed`. */
  iceConnect: number | null;
  /** ICE gathering `gathering` → `complete`. */
  iceGathering: number | null;
  /** First offer/answer exchange: first createOffer/setRemoteDescription → `stable`. */
  firstNegotiation: number | null;
  /** Total time spent in `connectionState: connected`. */
  connectedFor: number;
  /** `have-*` → `stable` round trips, the first one included. */
  negotiations: number;
  /** Times the connection or ICE dropped to `disconnected`/`failed`. */
  disconnections: number;
  iceRestarts: number;
}

export interface CaptureDevice {
  kind: string;
  label: string;
  deviceId: string | null;
  groupId: string | null;
  /** Short human summary of what was asked for, e.g. "ideal 1280×720 · 15–30 fps". */
  requested: string | null;
  source: 'camera/microphone' | 'screen';
}

export interface TrackSpan {
  state: 'live' | 'muted';
  from: number;
  to: number;
}

export interface TrackInfo {
  direction: 'local' | 'remote';
  kind: string;
  trackId: string;
  /** The device label for a local track, the stream id for a remote one. */
  label: string | null;
  addedAt: number;
  endedAt: number | null;
  endReason: 'ended' | 'stopped' | 'removed' | null;
  /** Live/muted periods from `addedAt` to `endedAt` (or the connection's end). */
  spans: TrackSpan[];
  device: CaptureDevice | null;
}

export interface DataChannelInfo {
  label: string;
  protocol: string | null;
  at: number;
}

export interface ConnectionReport {
  pcId: string;
  createdAt: number;
  closedAt: number | null;
  /** Last instant the connection was observed: its close, or its last event. */
  endAt: number;
  iceServers: string[];
  bundlePolicy: string | null;
  iceTransportPolicy: string | null;
  /** Final value of each state, for the panel header. */
  finalState: { connection: string; ice: string; signaling: string };
  lanes: StateLane[];
  milestones: Milestone[];
  timings: ConnectionTimings;
  tracks: TrackInfo[];
  dataChannels: DataChannelInfo[];
  events: TimelineEvent[];
}

const TONE: Record<string, StateTone> = {
  connected: 'good',
  completed: 'good',
  stable: 'good',
  complete: 'good',
  new: 'pending',
  checking: 'pending',
  connecting: 'pending',
  gathering: 'pending',
  'have-local-offer': 'pending',
  'have-remote-offer': 'pending',
  'have-local-pranswer': 'pending',
  'have-remote-pranswer': 'pending',
  disconnected: 'bad',
  failed: 'bad',
  closed: 'closed'
};

const LANES: { key: StateLane['key']; label: string; method: string; initial: string }[] = [
  { key: 'connection', label: 'Connection', method: 'onconnectionstatechange', initial: 'new' },
  { key: 'ice', label: 'ICE', method: 'oniceconnectionstatechange', initial: 'new' },
  { key: 'signaling', label: 'Signaling', method: 'onsignalingstatechange', initial: 'stable' },
  { key: 'gathering', label: 'Gathering', method: 'onicegatheringstatechange', initial: 'new' }
];

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toneOf(state: string): StateTone {
  return TONE[state] ?? 'pending';
}

/** Collapse a state change log into contiguous segments ending at `endAt`. */
function buildLane(
  trace: TraceEvent[],
  method: string,
  initial: string,
  startAt: number,
  endAt: number
): { segments: StateSegment[]; changes: { state: string; at: number }[] } {
  const changes = trace
    .filter((e) => e.type === method)
    .map((e) => ({ state: asString(e.value) ?? 'unknown', at: e.timestamp }));

  const segments: StateSegment[] = [];
  let state = initial;
  let from = startAt;
  for (const change of changes) {
    if (change.state === state) continue;
    if (change.at > from) segments.push({ state, tone: toneOf(state), from, to: change.at });
    state = change.state;
    from = change.at;
  }
  if (endAt > from) segments.push({ state, tone: toneOf(state), from, to: endAt });
  return { segments, changes };
}

function firstAt(changes: { state: string; at: number }[], states: string[], after = -Infinity): number | null {
  return changes.find((c) => states.includes(c.state) && c.at >= after)?.at ?? null;
}

function span(from: number | null, to: number | null): number | null {
  return from != null && to != null && to >= from ? to - from : null;
}

function iceServerUrls(configuration: Record<string, unknown> | null): string[] {
  const servers = Array.isArray(configuration?.iceServers) ? configuration.iceServers : [];
  return servers.flatMap((server) => {
    const urls = asRecord(server)?.urls;
    if (typeof urls === 'string') return [urls];
    return Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string') : [];
  });
}

// ─── Capture devices ────────────────────────────────────────────────────────────

interface EnumeratedDevice {
  deviceId: string;
  kind: string;
  label: string;
  groupId: string | null;
}

/** `deviceId` constraint in any of its shapes: a string, `{exact}` or `{ideal}`. */
function constrainedDeviceId(constraint: unknown): string | null {
  const record = asRecord(constraint);
  const deviceId = record?.deviceId;
  if (typeof deviceId === 'string') return deviceId;
  const nested = asRecord(deviceId);
  return asString(nested?.exact) ?? asString(nested?.ideal) ?? null;
}

function range(value: unknown, unit = ''): string | null {
  if (typeof value === 'number') return `${value}${unit}`;
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.exact === 'number') return `${record.exact}${unit}`;
  const min = typeof record.min === 'number' ? record.min : null;
  const max = typeof record.max === 'number' ? record.max : null;
  if (min != null && max != null) return `${min}–${max}${unit}`;
  if (typeof record.ideal === 'number') return `~${record.ideal}${unit}`;
  if (max != null) return `≤${max}${unit}`;
  if (min != null) return `≥${min}${unit}`;
  return null;
}

/** "~1280×~720 · 15–30 fps" for video, "AEC · NS · AGC" for audio. */
export function summarizeConstraints(kind: string, constraint: unknown): string | null {
  const record = asRecord(constraint);
  if (!record) return null;

  if (kind === 'video') {
    const width = range(record.width);
    const height = range(record.height);
    const fps = range(record.frameRate, ' fps');
    const parts = [width && height ? `${width}×${height}` : width ?? height, fps].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }

  const flags = [
    ['echoCancellation', 'AEC'],
    ['noiseSuppression', 'NS'],
    ['autoGainControl', 'AGC']
  ]
    .filter(([key]) => record[key] === true || asRecord(record[key])?.ideal === true || asRecord(record[key])?.exact === true)
    .map(([, name]) => name);
  return flags.length ? flags.join(' · ') : null;
}

/**
 * Map every captured track id to the device behind it.
 *
 * A `getUserMedia` call and its `OnSuccess` share a request id (`extra[0]`); the call
 * carries the constraints (and so the requested deviceId), the success carries the
 * resulting `[kind, trackId, label, streamId]` tracks. `enumerateDevices` then fills in
 * the device's groupId, and its deviceId when the request did not pin one.
 */
interface Captures {
  /** Device of every track a capture call handed out, by track id. */
  byTrack: Map<string, CaptureDevice>;
  /** Every captured track in capture order, for matching tracks the app re-wrapped. */
  captured: { kind: string; label: string; at: number; device: CaptureDevice }[];
  enumerated: EnumeratedDevice[];
}

function captureDevices(pageEvents: TraceEvent[]): Captures {
  const enumerated = new Map<string, EnumeratedDevice>();
  for (const event of pageEvents) {
    if (event.type !== 'navigator.mediaDevices.enumerateDevices' || !Array.isArray(event.value)) continue;
    for (const raw of event.value) {
      const device = asRecord(raw);
      const deviceId = asString(device?.deviceId);
      const kind = asString(device?.kind);
      if (!deviceId || !kind) continue;
      enumerated.set(`${kind}:${deviceId}`, {
        deviceId,
        kind,
        label: asString(device?.label) ?? '',
        groupId: asString(device?.groupId)
      });
    }
  }

  const requests = new Map<string, { constraints: Record<string, unknown> | null; source: CaptureDevice['source'] }>();
  const devices = new Map<string, CaptureDevice>();
  const captured: Captures['captured'] = [];

  for (const event of pageEvents) {
    const requestId = asString(event.extra[0]);
    const isDisplay = event.type.startsWith('navigator.mediaDevices.getDisplayMedia');
    const source: CaptureDevice['source'] = isDisplay ? 'screen' : 'camera/microphone';

    if (event.type === 'navigator.mediaDevices.getUserMedia' || event.type === 'navigator.mediaDevices.getDisplayMedia') {
      if (requestId) requests.set(requestId, { constraints: asRecord(event.value), source });
      continue;
    }
    if (event.type !== 'navigator.mediaDevices.getUserMediaOnSuccess'
      && event.type !== 'navigator.mediaDevices.getDisplayMediaOnSuccess') continue;

    const request = requestId ? requests.get(requestId) : undefined;
    for (const raw of Array.isArray(event.value) ? event.value : []) {
      if (!Array.isArray(raw)) continue;
      const kind = asString(raw[0]) ?? 'unknown';
      const trackId = asString(raw[1]);
      const label = asString(raw[2]) ?? '';
      if (!trackId) continue;

      const constraint = request?.constraints?.[kind];
      const inputKind = `${kind}input`;
      const pinned = constrainedDeviceId(constraint);
      const match = (pinned ? enumerated.get(`${inputKind}:${pinned}`) : undefined)
        ?? [...enumerated.values()].find((d) => d.kind === inputKind && d.label === label && label !== '');

      const resolvedSource = request?.source ?? source;
      const device: CaptureDevice = {
        kind,
        label: label || match?.label || (resolvedSource === 'screen' ? 'Screen capture' : 'Unknown device'),
        deviceId: pinned ?? match?.deviceId ?? null,
        groupId: match?.groupId ?? null,
        requested: summarizeConstraints(kind, constraint),
        source: resolvedSource
      };
      devices.set(trackId, device);
      captured.push({ kind, label, at: event.timestamp, device });
    }
  }
  return { byTrack: devices, captured, enumerated: [...enumerated.values()] };
}

/**
 * The device behind a sent track.
 *
 * The track id usually comes straight from a capture result. SDKs such as LiveKit
 * publish their own wrapped track instead, whose id no capture ever returned; it keeps
 * the source's kind and label, so the latest capture of that kind and label before the
 * track was added is its source, and failing that the device list entry with that label.
 */
function resolveDevice(captures: Captures, kind: string, trackId: string, label: string | null, at: number): CaptureDevice | null {
  const direct = captures.byTrack.get(trackId);
  if (direct) return direct;
  if (!label) return null;

  const capture = captures.captured.filter((c) => c.kind === kind && c.label === label && c.at <= at).pop();
  if (capture) return capture.device;

  const listed = captures.enumerated.find((d) => d.kind === `${kind}input` && d.label === label);
  return listed
    ? { kind, label, deviceId: listed.deviceId, groupId: listed.groupId, requested: null, source: 'camera/microphone' }
    : null;
}

// ─── Tracks ─────────────────────────────────────────────────────────────────────

/** Track ids an event refers to, in `value` or `extra`, as plain strings. */
function referencedIds(event: TraceEvent): string[] {
  return [event.value, ...event.extra].filter((v): v is string => typeof v === 'string');
}

/**
 * The `[kind, trackId, ...]` a track-adding event carries, or null when it adds none.
 *
 * `addTrack` logs `[kind, trackId, label]`; `addTransceiver` logs `[track, init]` where
 * the track is `[kind, trackId, label]` when one is attached and a bare kind string for
 * a receive-only transceiver; `ontrack` logs `[kind, trackId, streamId, label]`.
 */
function trackOf(event: TraceEvent): unknown[] | null {
  if (!Array.isArray(event.value)) return null;
  if (event.type === 'addTransceiver') return Array.isArray(event.value[0]) ? event.value[0] : null;
  return event.type === 'addTrack' || event.type === 'ontrack' ? event.value : null;
}

function buildTracks(trace: TraceEvent[], pageEvents: TraceEvent[], captures: Captures, endAt: number): TrackInfo[] {
  const tracks: TrackInfo[] = [];
  const byId = new Map<string, TrackInfo>();
  /** Every id an event may use for a track: its own, and its sender's. */
  const aliases = new Map<TrackInfo, string[]>();
  let awaitingSender: TrackInfo | null = null;

  for (const event of trace) {
    // The sender (or transceiver) id arrives on the success callback; removeTrack is
    // later called with it rather than with the track id.
    if ((event.type === 'addTrackOnSuccess' || event.type === 'addTransceiverOnSuccess') && awaitingSender) {
      const senderId = asString(event.extra[0]);
      if (senderId) aliases.get(awaitingSender)?.push(senderId);
      awaitingSender = null;
      continue;
    }

    const value = trackOf(event);
    if (!value) continue;
    const direction = event.type === 'ontrack' ? 'remote' : 'local';
    const kind = asString(value[0]) ?? 'unknown';
    const trackId = asString(value[1]);
    if (!trackId || byId.has(`${direction}:${trackId}`)) continue;

    const label = direction === 'local' ? asString(value[2]) : asString(value[3]) ?? asString(value[2]);
    const track: TrackInfo = {
      direction,
      kind,
      trackId,
      label,
      addedAt: event.timestamp,
      endedAt: null,
      endReason: null,
      spans: [],
      device: direction === 'local' ? resolveDevice(captures, kind, trackId, label, event.timestamp) : null
    };
    tracks.push(track);
    byId.set(`${direction}:${trackId}`, track);
    aliases.set(track, [trackId]);
    if (direction === 'local') awaitingSender = track;
  }

  // Mute/unmute/end can be logged on the connection or, for local capture tracks, at
  // page level; a track is matched wherever its id appears.
  const lifecycle = [...trace, ...pageEvents]
    .filter((e) => e.type.startsWith('MediaStreamTrack.') || e.type === 'removeTrack')
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const track of tracks) {
    const ids = aliases.get(track) ?? [track.trackId];
    const events = lifecycle.filter((e) => e.timestamp >= track.addedAt && referencedIds(e).some((id) => ids.includes(id)));
    const end = events.find((e) => ['MediaStreamTrack.onended', 'MediaStreamTrack.stop', 'removeTrack'].includes(e.type));
    if (end) {
      track.endedAt = end.timestamp;
      track.endReason = end.type === 'MediaStreamTrack.onended' ? 'ended' : end.type === 'removeTrack' ? 'removed' : 'stopped';
    }
    const until = Math.min(track.endedAt ?? endAt, endAt);

    // A remote track starts muted until its first packet; a local one starts live.
    let state: TrackSpan['state'] = track.direction === 'remote' ? 'muted' : 'live';
    let from = track.addedAt;
    for (const event of events) {
      if (event.timestamp > until) break;
      const next = event.type === 'MediaStreamTrack.onmute' ? 'muted'
        : event.type === 'MediaStreamTrack.onunmute' ? 'live'
        : null;
      if (!next || next === state) continue;
      if (event.timestamp > from) track.spans.push({ state, from, to: event.timestamp });
      state = next;
      from = event.timestamp;
    }
    if (until > from) track.spans.push({ state, from, to: until });
  }

  return tracks;
}

// ─── Report ─────────────────────────────────────────────────────────────────────

function buildReport(
  pcId: string,
  trace: TraceEvent[],
  pageEvents: TraceEvent[],
  captures: Captures,
  events: TimelineEvent[]
): ConnectionReport | null {
  if (trace.length === 0) return null;

  const create = trace.find((e) => e.type === 'create');
  const createdAt = create?.timestamp ?? trace[0].timestamp;
  const close = trace.find((e) => e.type === 'close');
  const closedAt = close?.timestamp ?? null;
  const endAt = Math.max(closedAt ?? -Infinity, trace[trace.length - 1].timestamp, createdAt);
  const configuration = asRecord(create?.value);

  const built = Object.fromEntries(
    LANES.map((lane) => [lane.key, buildLane(trace, lane.method, lane.initial, createdAt, endAt)])
  ) as Record<StateLane['key'], ReturnType<typeof buildLane>>;

  const lanes: StateLane[] = LANES.map((lane) => ({ key: lane.key, label: lane.label, segments: built[lane.key].segments }));
  const connection = built.connection.changes;
  const ice = built.ice.changes;
  const signaling = built.signaling.changes;
  const gathering = built.gathering.changes;

  const negotiationStart = trace.find((e) => e.type === 'createOffer' || e.type === 'setRemoteDescription')?.timestamp ?? null;
  const iceChecking = firstAt(ice, ['checking']);
  const iceConnected = firstAt(ice, ['connected', 'completed']);
  const connected = firstAt(connection, ['connected']);
  const gatheringStart = firstAt(gathering, ['gathering']);

  const connectedFor = built.connection.segments
    .filter((s) => s.state === 'connected')
    .reduce((total, s) => total + (s.to - s.from), 0);

  let negotiations = 0;
  let previous = 'stable';
  for (const change of signaling) {
    if (change.state === 'stable' && previous.startsWith('have-')) negotiations += 1;
    previous = change.state;
  }

  const timings: ConnectionTimings = {
    timeToConnected: span(createdAt, connected),
    iceConnect: span(iceChecking, iceConnected),
    iceGathering: span(gatheringStart, firstAt(gathering, ['complete'], gatheringStart ?? -Infinity)),
    firstNegotiation: span(negotiationStart, firstAt(signaling, ['stable'], negotiationStart ?? Infinity)),
    connectedFor,
    negotiations,
    disconnections: [...connection, ...ice].filter((c) => c.state === 'disconnected' || c.state === 'failed').length,
    iceRestarts: trace.filter((e) => e.type === 'restartIce').length
  };

  const milestones: Milestone[] = [
    { label: 'Created', at: createdAt },
    negotiationStart != null ? { label: 'Negotiation started', at: negotiationStart } : null,
    iceChecking != null ? { label: 'ICE checking', at: iceChecking } : null,
    iceConnected != null ? { label: 'ICE connected', at: iceConnected } : null,
    connected != null ? { label: 'Connected', at: connected } : null,
    closedAt != null ? { label: 'Closed', at: closedAt } : null
  ].filter((m): m is Milestone => m !== null);

  const last = (changes: { state: string }[], fallback: string) => changes[changes.length - 1]?.state ?? fallback;

  return {
    pcId,
    createdAt,
    closedAt,
    endAt,
    iceServers: iceServerUrls(configuration),
    bundlePolicy: asString(configuration?.bundlePolicy),
    iceTransportPolicy: asString(configuration?.iceTransportPolicy),
    finalState: {
      connection: closedAt != null ? 'closed' : last(connection, 'new'),
      ice: closedAt != null ? 'closed' : last(ice, 'new'),
      signaling: closedAt != null ? 'closed' : last(signaling, 'stable')
    },
    lanes,
    milestones,
    timings,
    tracks: buildTracks(trace, pageEvents, captures, endAt),
    dataChannels: trace
      .filter((e) => e.type === 'createDataChannel' && Array.isArray(e.value))
      .map((e) => {
        const [label, options] = e.value as unknown[];
        return { label: asString(label) ?? '', protocol: asString(asRecord(options)?.protocol) || null, at: e.timestamp };
      }),
    events
  };
}

/**
 * One report per peer connection, in dump order, for the per-connection timeline panels.
 *
 * Page-level events (capture requests, device enumeration) are not part of any
 * connection's trace but are what identifies the devices behind its local tracks.
 */
export function buildConnectionReports(dump: DecodedDump | null): ConnectionReport[] {
  if (!dump?.peerConnections) return [];

  const pageEvents = dump.peerConnections[PAGE_LEVEL_PC_ID] ?? [];
  const captures = captureDevices(pageEvents);
  const timeline = buildTimeline(dump);

  const reports: ConnectionReport[] = [];
  for (const [pcId, trace] of Object.entries(dump.peerConnections)) {
    if (pcId === PAGE_LEVEL_PC_ID) continue;
    const report = buildReport(pcId, trace, pageEvents, captures, timeline.filter((e) => e.pcId === pcId));
    if (report) reports.push(report);
  }
  return reports;
}
