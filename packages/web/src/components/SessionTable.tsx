import type { KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SessionSummary } from '../lib/api.js';
import { formatDateTime, formatDuration, formatRelative } from '../lib/format.js';
import { MosBadge, ScoreBadge, type Severity } from './ScoreBadge.js';
import styles from './SessionTable.module.css';

export interface SessionTableProps {
  items: SessionSummary[];
  loading: boolean;
  error: string | null;
  onChipClick: (type: string) => void;
  /** Search params to carry into the detail page, so Back restores the list. */
  detailSearch?: string;
}

const COLUMNS = ['Started', 'Duration', 'User', 'Conference', 'Score', 'MOS', 'Issues'];

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }, (_, row) => (
        <tr key={row}>
          {COLUMNS.map((column, cell) => (
            <td key={column}>
              <div className={styles.skeleton} style={{ width: `${[70, 45, 60, 65, 40, 70, 80][cell]}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function SessionTable({ items, loading, error, onChipClick, detailSearch = '' }: SessionTableProps) {
  const navigate = useNavigate();

  function open(dumpId: number) {
    navigate({ pathname: `/sessions/${dumpId}`, search: detailSearch });
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, dumpId: number) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(dumpId);
    }
  }

  if (error) {
    return (
      <div className={styles.card}>
        <div className={`${styles.state} ${styles.stateError}`}>
          <p className={styles.stateTitle}>Could not load calls</p>
          <p className={styles.stateBody}>{error}</p>
        </div>
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className={styles.card}>
        <div className={styles.state}>
          <p className={styles.stateTitle}>No calls match these filters</p>
          <p className={styles.stateBody}>
            Try a shorter search term, a wider date range, or clearing the severity filter.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} scope="col">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <SkeletonRows />
            ) : (
              items.map((item) => (
                <tr
                  key={item.dumpId}
                  className={styles.row}
                  tabIndex={0}
                  onClick={() => open(item.dumpId)}
                  onKeyDown={(e) => onRowKeyDown(e, item.dumpId)}
                >
                  <td className={styles.started}>
                    {formatDateTime(item.sessionStart)}
                    <span className={styles.relative}>{formatRelative(item.sessionStart)}</span>
                  </td>
                  <td className={styles.duration}>{formatDuration(item.duration)}</td>
                  <td className={styles.name}>
                    <Link
                      to={{ pathname: `/sessions/${item.dumpId}`, search: detailSearch }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {item.rtcstatsUser ?? `dump ${item.dumpId}`}
                    </Link>
                  </td>
                  <td className={styles.muted}>{item.rtcstatsConference ?? <span className={styles.faint}>—</span>}</td>
                  <td>
                    <ScoreBadge score={item.experienceScore} worstSeverity={item.worstSeverity as Severity} />
                  </td>
                  <td>
                    <div className={styles.mos}>
                      <MosBadge label="A" mos={item.audioMos} />
                      <MosBadge label="V" mos={item.videoMos} />
                    </div>
                  </td>
                  <td>
                    <div className={styles.issues}>
                      {item.topObservationTypes.length === 0 && <span className={styles.faint}>—</span>}
                      {item.topObservationTypes.map((type) => (
                        <button
                          key={type}
                          type="button"
                          className={styles.issueChip}
                          title={`Filter by ${type}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onChipClick(type);
                          }}
                        >
                          {type}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
