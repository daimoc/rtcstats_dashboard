import { formatDuration } from '../lib/format.js';
import type { EventSeverity, TimelineEvent } from '../lib/dumpTimeline.js';
import { describeDumpState, type DumpState } from '../lib/useDumpData.js';
import styles from './EventTimeline.module.css';

const SEVERITY_CLASS: Record<EventSeverity, string> = {
  critical: styles.critical,
  warning: styles.warning,
  info: styles.info
};

export interface EventTimelineProps {
  dump: DumpState;
}

function timeOfDay(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h3 className={styles.title}>Session timeline</h3>
      {children}
    </div>
  );
}

/**
 * The session's events in the order they happened.
 *
 * Everything here comes from the raw dump, which is the only place real timestamps
 * exist: observations carry `firstSeenAt: null` from every rule, and the `features_*`
 * tree has no time dimension at all, so neither can place an event on a time axis.
 * Observations are shown in the Verdict panel instead.
 */
export function EventTimeline({ dump }: EventTimelineProps) {
  const notice = describeDumpState(dump);
  if (notice) {
    return (
      <Frame>
        <p className={styles.empty}>{notice}</p>
      </Frame>
    );
  }

  const events = dump.status === 'ready' ? dump.result.timeline : [];
  if (events.length === 0) {
    return (
      <Frame>
        <p className={styles.empty}>No timeline events in this dump.</p>
      </Frame>
    );
  }

  const start = events[0].timestamp;

  return (
    <Frame>
      <div className={styles.list}>
        {events.map((event: TimelineEvent, i) => (
          <div
            key={`${event.type}-${event.timestamp}-${event.pcId}-${i}`}
            className={`${styles.item} ${SEVERITY_CLASS[event.severity]}`}
          >
            <div className={styles.head}>
              <span className={styles.severity}>{event.severity}</span>
              <span className={styles.label}>{event.label}</span>
              {event.pcId !== 'null' && <span className={styles.pcId}>{event.pcId}</span>}
            </div>
            {event.details && <div className={styles.details}>{event.details}</div>}
            <div className={styles.timestamp}>
              +{formatDuration((event.timestamp - start) / 1000)} · {timeOfDay(event.timestamp)}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}
