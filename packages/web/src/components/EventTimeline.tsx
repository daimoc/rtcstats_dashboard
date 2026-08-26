import type { Observation, FeatureConnection } from '../lib/api.js';

interface TimelineEvent {
  timestamp: number | null;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  label: string;
  details?: string;
  pcId?: string;
}

const SEVERITY_COLORS: Record<'critical' | 'warning' | 'info', string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
};

function deriveEventsFromObservations(observations: Observation[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const obs of observations) {
    const severity = obs.severity;

    if (obs.type.startsWith('connectivity.')) {
      if (obs.type.includes('ice')) {
        events.push({
          timestamp: obs.firstSeenAt,
          type: obs.type,
          severity,
          label: obs.type.includes('restart') ? 'ICE Restart' : 'ICE Event',
          details: obs.type.replace('connectivity.', ''),
          pcId: obs.pid ?? undefined,
        });
      }

      if (obs.type === 'connectivity.never_connected') {
        events.push({
          timestamp: obs.firstSeenAt,
          type: obs.type,
          severity: 'critical',
          label: 'Connection Never Established ICE Connectivity',
          details: `Connection ${obs.pid ?? 'unknown'} never connected via ICE.`,
          pcId: obs.pid ?? undefined,
        });
      }

      if (obs.type === 'connectivity.ice_restart') {
        events.push({
          timestamp: obs.firstSeenAt,
          type: obs.type,
          severity: 'info',
          label: 'ICE Restart Detected',
          details: 'ICE restart performed on connection.',
          pcId: obs.pid ?? undefined,
        });
      }

      if (obs.type === 'connectivity.relay_only_path') {
        events.push({
          timestamp: obs.firstSeenAt,
          type: obs.type,
          severity: 'warning',
          label: 'Traffic Routed Through TURN Relay',
          details: `Connection ${obs.pid ?? 'unknown'} used relay path.`,
          pcId: obs.pid ?? undefined,
        });
      }
    }

    if (obs.type.startsWith('video.')) {
      events.push({
        timestamp: obs.firstSeenAt,
        type: obs.type,
        severity,
        label: `Video: ${obs.type.replace('video.', '')}`,
        details: obs.type,
        pcId: obs.pid ?? undefined,
      });
    }

    if (obs.type.startsWith('audio.')) {
      events.push({
        timestamp: obs.firstSeenAt,
        type: obs.type,
        severity,
        label: `Audio: ${obs.type.replace('audio.', '')}`,
        details: obs.type,
        pcId: obs.pid ?? undefined,
      });
    }

    if (obs.type.startsWith('api.')) {
      events.push({
        timestamp: obs.firstSeenAt,
        type: obs.type,
        severity: severity === 'info' ? 'warning' : severity,
        label: `API Error: ${obs.type.replace('api.', '')}`,
        details: obs.type,
        pcId: obs.pid ?? undefined,
      });
    }

    if (obs.type.startsWith('device.')) {
      events.push({
        timestamp: obs.firstSeenAt,
        type: obs.type,
        severity,
        label: `Device: ${obs.type.replace('device.', '')}`,
        details: obs.type,
        pcId: obs.pid ?? undefined,
      });
    }
  }

  return events;
}

function deriveEventsFromFeatures(features: { connections: FeatureConnection[] } | null): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (!features?.connections) return events;

  for (const conn of features.connections) {
    events.push({
      timestamp: conn.createdAt as number | null,
      type: 'connection.started',
      severity: 'info',
      label: 'Peer Connection Started',
      details: `Connection ${conn.connectionIdentifier ?? `#${conn.id}`}`,
      pcId: String(conn.id),
    });

    for (const track of conn.tracks || []) {
      events.push({
        timestamp: (track as Record<string, unknown>).timestamp as number | null,
        type: 'track.started',
        severity: 'info',
        label: `${track.kind ?? 'unknown'} Track Started`,
        details: `${track.kind ?? 'unknown'} track: ${track.trackIdentifier ?? 'unnamed'}`,
        pcId: String(conn.id),
      });
    }
  }

  return events;
}

function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  return events
    .filter(e => e.timestamp != null)
    .sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
      const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return (a.timestamp ?? 0) - (b.timestamp ?? 0);
    });
}

export interface EventTimelineProps {
  observations: Observation[];
  features: { connections: FeatureConnection[] } | null;
}

export function EventTimeline({ observations, features }: EventTimelineProps) {
  const allEvents = sortEvents([
    ...deriveEventsFromObservations(observations),
    ...deriveEventsFromFeatures(features),
  ]);

  if (allEvents.length === 0) {
    return <p className="event-timeline-empty">No timeline events available.</p>;
  }

  return (
    <div className="event-timeline">
      <h3>Session Timeline</h3>
      <div className="event-timeline-list">
        {allEvents.map((event, i) => (
          <div
            key={`${event.type}-${event.timestamp}-${event.pcId}-${i}`}
            className="event-timeline-item"
            style={{ borderLeft: `3px solid ${SEVERITY_COLORS[event.severity]}` }}
          >
            <div className="event-timeline-header">
              <span
                className="event-timeline-severity"
                style={{ color: SEVERITY_COLORS[event.severity] }}
              >
                {event.severity}
              </span>
              <span className="event-timeline-label">{event.label}</span>
              {event.pcId && (
                <span className="event-timeline-pc-id">PC #{event.pcId}</span>
              )}
            </div>
            <div className="event-timeline-details">
              {event.details}
            </div>
            {event.timestamp != null && (
              <div className="event-timeline-timestamp">
                {new Date(event.timestamp).toLocaleString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
