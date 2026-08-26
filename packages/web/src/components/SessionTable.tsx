import { Link } from 'react-router-dom';
import type { SessionSummary } from '../lib/api.js';
import { ScoreBadge } from './ScoreBadge.js';

export interface SessionTableProps {
  items: SessionSummary[];
  onChipClick: (type: string) => void;
}

export function SessionTable({ items, onChipClick }: SessionTableProps) {
  return (
    <table>
      <thead>
        <tr>
          <th>Start</th><th>Duration</th><th>User</th><th>Conference</th><th>Score</th><th>Observations</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.dumpId}>
            <td><Link to={`/sessions/${item.dumpId}`}>{item.rtcstatsUser ?? `dump ${item.dumpId}`}</Link></td>
            <td>{item.duration != null ? `${item.duration}s` : '—'}</td>
            <td>{item.rtcstatsUser ?? '—'}</td>
            <td>{item.rtcstatsConference ?? '—'}</td>
            <td><ScoreBadge score={item.experienceScore} worstSeverity={item.worstSeverity as 'critical' | 'warning' | 'info' | null} /></td>
            <td>
              {item.topObservationTypes.map((type) => (
                <button key={type} onClick={() => onChipClick(type)}>{type}</button>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
