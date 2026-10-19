import { useState } from 'react';
import type { ConnectionReport, StateTone, TrackInfo } from '../lib/connectionReport.js';
import type { EventSeverity } from '../lib/dumpTimeline.js';
import { formatElapsed } from '../lib/format.js';
import { describeDumpState, type DumpState } from '../lib/useDumpData.js';
import styles from './ConnectionTimelines.module.css';

export interface ConnectionTimelinesProps {
  dump: DumpState;
  /** Jump to this connection's evidence charts. */
  onShowCharts?: (pcId: string) => void;
}

const TONE_CLASS: Record<StateTone, string> = {
  good: styles.good,
  pending: styles.pending,
  bad: styles.bad,
  closed: styles.closed
};

const SEVERITY_CLASS: Record<EventSeverity, string> = {
  critical: styles.eventCritical,
  warning: styles.eventWarning,
  info: styles.eventInfo
};

/** Final states worth a coloured badge in the panel header. */
const FINAL_TONE: Record<string, StateTone> = {
  connected: 'good',
  completed: 'good',
  failed: 'bad',
  disconnected: 'bad',
  closed: 'closed'
};

interface View {
  from: number;
  to: number;
}

function timeOfDay(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function offset(report: ConnectionReport, at: number): string {
  return `+${formatElapsed(at - report.createdAt)}`;
}

/** Position of [from, to] inside the view, as CSS percentages; null when outside it. */
function place(view: View, from: number, to: number): { left: string; width: string } | null {
  const total = view.to - view.from;
  if (total <= 0 || to < view.from || from > view.to) return null;
  const start = Math.max(from, view.from);
  const end = Math.min(to, view.to);
  return {
    left: `${((start - view.from) / total) * 100}%`,
    width: `${Math.max(((end - start) / total) * 100, 0.15)}%`
  };
}

/**
 * The view that shows how the connection was established. On a 30-minute axis the
 * whole set-up is a sub-pixel sliver, so it gets its own zoom: twice the time it took to
 * connect, at least three seconds, never past the end of the connection.
 */
function setupView(report: ConnectionReport): View {
  const settled = report.timings.timeToConnected ?? 10_000;
  return { from: report.createdAt, to: Math.min(report.endAt, report.createdAt + Math.max(3000, settled * 2)) };
}

function trackLabel(track: TrackInfo): string {
  const arrow = track.direction === 'local' ? '↑' : '↓';
  return `${arrow} ${track.kind}`;
}

/**
 * What tells one track from another of the same kind: the capture device for a sent
 * track, the stream id for a received one (or its track id when the stream repeats it).
 */
function trackName(track: TrackInfo): string {
  if (track.device) return track.device.label;
  if (track.direction === 'remote' && track.label && track.label !== track.trackId) return track.label;
  return track.trackId;
}

function trackColorClass(track: TrackInfo): string {
  if (track.direction === 'local') return styles.trackLocal;
  return track.kind === 'audio' ? styles.trackRemoteAudio : styles.trackRemoteVideo;
}

function Axis({ view }: { view: View }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className={styles.row} aria-hidden="true">
      <span className={styles.rowLabel} />
      <div className={styles.axis}>
        {ticks.map((fraction) => (
          <span
            key={fraction}
            className={styles.tick}
            style={{ left: `${fraction * 100}%` }}
            data-edge={fraction === 0 ? 'start' : fraction === 1 ? 'end' : undefined}
            data-minor={fraction === 0.25 || fraction === 0.75 ? '' : undefined}
          >
            +{formatElapsed((view.to - view.from) * fraction)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Swimlanes({ report, view }: { report: ConnectionReport; view: View }) {
  return (
    <div className={styles.lanes}>
      <Axis view={view} />

      {report.lanes.map((lane) => (
        <div key={lane.key} className={styles.row}>
          <span className={styles.rowLabel}>{lane.label}</span>
          <div className={styles.track}>
            {lane.segments.map((segment) => {
              const position = place(view, segment.from, segment.to);
              if (!position) return null;
              const title = `${lane.label}: ${segment.state} · ${offset(report, segment.from)} → ${offset(report, segment.to)} (${formatElapsed(segment.to - segment.from)})`;
              return (
                <span
                  key={segment.from}
                  className={`${styles.segment} ${TONE_CLASS[segment.tone]}`}
                  style={position}
                  title={title}
                  aria-label={title}
                >
                  <span className={styles.segmentText}>{segment.state}</span>
                </span>
              );
            })}
          </div>
        </div>
      ))}

      {report.tracks.map((track) => (
        <div key={`${track.direction}-${track.trackId}`} className={styles.row}>
          <span className={styles.rowLabel} title={`${trackLabel(track)} · ${trackName(track)}`}>
            {trackLabel(track)} <span className={styles.faint}>{trackName(track)}</span>
          </span>
          <div className={styles.track}>
            {track.spans.map((spanItem) => {
              const position = place(view, spanItem.from, spanItem.to);
              if (!position) return null;
              const title = `${trackLabel(track)} ${spanItem.state} · ${offset(report, spanItem.from)} → ${offset(report, spanItem.to)}`;
              return (
                <span
                  key={spanItem.from}
                  className={`${styles.segment} ${spanItem.state === 'muted' ? styles.muted : trackColorClass(track)}`}
                  style={position}
                  title={title}
                  aria-label={title}
                />
              );
            })}
          </div>
        </div>
      ))}

      <div className={styles.row}>
        <span className={styles.rowLabel}>Events</span>
        <div className={styles.track}>
          {report.events.map((event, i) => {
            const position = place(view, event.timestamp, event.timestamp);
            if (!position) return null;
            const title = `${event.label}${event.details ? ` — ${event.details}` : ''} · ${offset(report, event.timestamp)}`;
            return (
              <span
                key={`${event.timestamp}-${i}`}
                className={`${styles.marker} ${SEVERITY_CLASS[event.severity]}`}
                style={{ left: position.left }}
                title={title}
                aria-label={title}
              />
            );
          })}
        </div>
      </div>

      <div className={styles.legend} aria-hidden="true">
        <span><i className={`${styles.swatch} ${styles.good}`} />established</span>
        <span><i className={`${styles.swatch} ${styles.pending}`} />in progress</span>
        <span><i className={`${styles.swatch} ${styles.bad}`} />disconnected / failed</span>
        <span><i className={`${styles.swatch} ${styles.trackLocal}`} />sent track</span>
        <span><i className={`${styles.swatch} ${styles.trackRemoteAudio}`} />received audio</span>
        <span><i className={`${styles.swatch} ${styles.trackRemoteVideo}`} />received video</span>
        <span><i className={`${styles.swatch} ${styles.muted}`} />muted</span>
      </div>
    </div>
  );
}

/** "28 (4 stun · 12 turn · 12 turns)": the scheme mix says more than 28 hostnames. */
function iceServerSummary(urls: string[]): string {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const scheme = url.split(':')[0];
    counts.set(scheme, (counts.get(scheme) ?? 0) + 1);
  }
  return `${urls.length} (${[...counts].map(([scheme, n]) => `${n} ${scheme}`).join(' · ')})`;
}

function IceServers({ urls }: { urls: string[] }) {
  if (urls.length === 0) return <>none (host candidates only)</>;
  if (urls.length <= 3) return <>{urls.join(', ')}</>;
  return (
    <details className={styles.servers}>
      <summary>{iceServerSummary(urls)}</summary>
      <ul>
        {urls.map((url, i) => <li key={`${url}-${i}`}>{url}</li>)}
      </ul>
    </details>
  );
}

function Timing({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.timing}>
      <span className={styles.timingLabel}>{label}</span>
      <span className={styles.timingValue}>{value}</span>
    </div>
  );
}

function TrackTable({ report }: { report: ConnectionReport }) {
  if (report.tracks.length === 0) {
    return <p className={styles.note}>No tracks were added to or received on this connection.</p>;
  }

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Track</th>
            <th scope="col">Device / stream</th>
            <th scope="col">Requested</th>
            <th scope="col">Added</th>
            <th scope="col">Ended</th>
          </tr>
        </thead>
        <tbody>
          {report.tracks.map((track) => (
            <tr key={`${track.direction}-${track.trackId}`}>
              <td>
                <span className={`${styles.dot} ${trackColorClass(track)}`} />
                {track.direction === 'local' ? 'Sent' : 'Received'} {track.kind}
                <div className={styles.mono} title={track.trackId}>{track.trackId}</div>
              </td>
              <td>
                {track.device ? (
                  <>
                    {track.device.label}
                    {track.device.source === 'screen' && <span className={styles.pill}>screen</span>}
                    {track.device.deviceId && (
                      <div className={styles.mono} title={track.device.deviceId}>{track.device.deviceId}</div>
                    )}
                  </>
                ) : track.direction === 'remote' ? (
                  track.label && track.label !== track.trackId
                    ? <span className={styles.mono} title={track.label}>{track.label}</span>
                    : <span className={styles.faint}>—</span>
                ) : (
                  <span className={styles.faint}>{track.label ?? 'Unknown device'}</span>
                )}
              </td>
              <td>{track.device?.requested ?? <span className={styles.faint}>—</span>}</td>
              <td className={styles.num}>{offset(report, track.addedAt)}</td>
              <td className={styles.num}>
                {track.endedAt != null
                  ? `${offset(report, track.endedAt)} (${track.endReason})`
                  : <span className={styles.faint}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConnectionPanel({ report, onShowCharts }: { report: ConnectionReport; onShowCharts?: (pcId: string) => void }) {
  const [zoom, setZoom] = useState<'full' | 'setup'>('full');
  const view = zoom === 'full' ? { from: report.createdAt, to: report.endAt } : setupView(report);
  const { timings, finalState } = report;
  const finalTone = FINAL_TONE[finalState.connection] ?? 'pending';

  return (
    <article className={styles.panel} aria-labelledby={`pc-${report.pcId}`}>
      <header className={styles.head}>
        <h3 id={`pc-${report.pcId}`} className={styles.pcId}>{report.pcId}</h3>
        <span className={`${styles.state} ${TONE_CLASS[finalTone]}`}>{finalState.connection}</span>
        <span className={styles.meta}>
          {timeOfDay(report.createdAt)} → {timeOfDay(report.endAt)} · {formatElapsed(report.endAt - report.createdAt)}
        </span>
        <div className={styles.actions}>
          <div className={styles.segmented} role="group" aria-label={`Time range for ${report.pcId}`}>
            <button type="button" aria-pressed={zoom === 'full'} onClick={() => setZoom('full')}>Full</button>
            <button type="button" aria-pressed={zoom === 'setup'} onClick={() => setZoom('setup')}>Set-up</button>
          </div>
          {onShowCharts && (
            <button type="button" className={styles.link} onClick={() => onShowCharts(report.pcId)}>
              Charts ↓
            </button>
          )}
        </div>
      </header>

      <dl className={styles.config}>
        <div>
          <dt>ICE servers</dt>
          <dd><IceServers urls={report.iceServers} /></dd>
        </div>
        {report.bundlePolicy && <div><dt>Bundle</dt><dd>{report.bundlePolicy}</dd></div>}
        {report.iceTransportPolicy && <div><dt>Transport policy</dt><dd>{report.iceTransportPolicy}</dd></div>}
        {report.dataChannels.length > 0 && (
          <div>
            <dt>Data channels</dt>
            <dd>{report.dataChannels.map((c) => c.label || '(unnamed)').join(', ')}</dd>
          </div>
        )}
      </dl>

      <div className={styles.timings}>
        <Timing label="Time to connected" value={formatElapsed(timings.timeToConnected)} />
        <Timing label="ICE checking → connected" value={formatElapsed(timings.iceConnect)} />
        <Timing label="ICE gathering" value={formatElapsed(timings.iceGathering)} />
        <Timing label="First negotiation" value={formatElapsed(timings.firstNegotiation)} />
        <Timing label="Connected for" value={formatElapsed(timings.connectedFor)} />
        <Timing label="Negotiations" value={String(timings.negotiations)} />
        <Timing label="Disconnections" value={String(timings.disconnections)} />
        <Timing label="ICE restarts" value={String(timings.iceRestarts)} />
      </div>

      <Swimlanes report={report} view={view} />

      <h4 className={styles.subTitle}>Tracks &amp; devices</h4>
      <TrackTable report={report} />

      <details className={styles.events}>
        <summary>{report.events.length} {report.events.length === 1 ? 'event' : 'events'}</summary>
        <ol className={styles.eventList}>
          {report.events.map((event, i) => (
            <li key={`${event.timestamp}-${i}`} className={SEVERITY_CLASS[event.severity]}>
              <span className={styles.num}>{offset(report, event.timestamp)}</span>
              <span className={styles.eventLabel}>{event.label}</span>
              {event.details && <span className={styles.faint}>{event.details}</span>}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

/**
 * One timeline panel per peer connection: how its connection, ICE, signaling and
 * gathering states evolved, how long each set-up step took, and which tracks it carried
 * from which capture device. All of it comes from the raw dump.
 */
export function ConnectionTimelines({ dump, onShowCharts }: ConnectionTimelinesProps) {
  const notice = describeDumpState(dump);
  if (notice) return <p className={styles.empty}>{notice}</p>;

  const reports = dump.status === 'ready' ? dump.result.reports : [];
  if (reports.length === 0) return <p className={styles.empty}>This dump holds no peer connections.</p>;

  return (
    <div className={styles.list}>
      {reports.map((report) => (
        <ConnectionPanel key={report.pcId} report={report} onShowCharts={onShowCharts} />
      ))}
    </div>
  );
}
