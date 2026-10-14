import type { Observation } from '../lib/api.js';
import { describeObservation } from '../messages/observationMessages.js';
import styles from './VerdictList.module.css';

export interface VerdictListProps {
  observations: Observation[];
  onShowEvidence: (observation: Observation) => void;
}

const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const;

export function VerdictList({ observations, onShowEvidence }: VerdictListProps) {
  if (observations.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyMark}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 13 4 4L19 7" />
          </svg>
        </span>
        <p>No issues detected.</p>
      </div>
    );
  }

  return (
    <div>
      {SEVERITY_ORDER.filter((severity) => observations.some((o) => o.severity === severity)).map((severity) => {
        const forSeverity = observations.filter((o) => o.severity === severity);

        return (
          <section key={severity} className={`${styles.group} ${styles[severity]}`}>
            <h3 className={styles.groupHead}>
              {severity}
              <span className={styles.count}><span className={styles.countInner}>{forSeverity.length}</span></span>
            </h3>
            <ul className={styles.list}>
              {forSeverity.map((o, i) => (
                <li key={`${o.type}-${o.pid}-${i}`} className={styles.item}>
                  <span className={styles.text}>
                    {describeObservation(o)}
                    <span className={styles.pid}>{o.type}{o.pid ? ` · PC ${o.pid}` : ''}</span>
                  </span>
                  <button type="button" className={styles.evidence} onClick={() => onShowEvidence(o)}>
                    Show evidence
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
