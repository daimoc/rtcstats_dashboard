import type { Observation } from '../lib/api.js';
import { describeObservation } from '../messages/observationMessages.js';

export interface VerdictListProps {
  observations: Observation[];
  onShowEvidence: (observation: Observation) => void;
}

const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const;

export function VerdictList({ observations, onShowEvidence }: VerdictListProps) {
  if (observations.length === 0) return <p>No issues detected.</p>;

  return (
    <div>
      {SEVERITY_ORDER.filter((severity) => observations.some((o) => o.severity === severity)).map((severity) => (
        <section key={severity}>
          <h3>{severity}</h3>
          <ul>
            {observations.filter((o) => o.severity === severity).map((o, i) => (
              <li key={`${o.type}-${o.pid}-${i}`}>
                {describeObservation(o)}
                <button onClick={() => onShowEvidence(o)}>Show evidence</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
