import { formatMos, mosTone } from '../lib/mos.js';
import styles from './ScoreBadge.module.css';

export type Severity = 'critical' | 'warning' | 'info' | null;

export interface ScoreBadgeProps {
  score: number | null;
  worstSeverity: Severity;
}

/** The severity band a score falls in — shared by the badge and the ring. */
export function scoreTone(score: number | null, worstSeverity: Severity): 'critical' | 'warning' | 'ok' | 'unknown' {
  if (score == null) return 'unknown';
  if (worstSeverity === 'critical' || score < 50) return 'critical';
  if (worstSeverity === 'warning' || score < 80) return 'warning';
  return 'ok';
}

export function ScoreBadge({ score, worstSeverity }: ScoreBadgeProps) {
  const tone = scoreTone(score, worstSeverity);

  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      <span className={styles.dot} />
      {score == null ? '—' : Math.round(score)}
    </span>
  );
}

export interface MosBadgeProps {
  /** Short visible label, e.g. "Audio". */
  label: string;
  mos: number | null;
}

/** A MOS on the 1–5 scale, coloured by the G.107 satisfaction band it falls in. */
export function MosBadge({ label, mos }: MosBadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[mosTone(mos)]}`} title={`${label} MOS (1–5)`}>
      <span className={styles.badgeLabel}>{label}</span>
      {formatMos(mos)}
    </span>
  );
}

export interface ScoreRingProps {
  score: number | null;
  worstSeverity: Severity;
}

export function ScoreRing({ score, worstSeverity }: ScoreRingProps) {
  const tone = scoreTone(score, worstSeverity);
  const toneClass = {
    critical: styles.ringCritical,
    warning: styles.ringWarning,
    ok: styles.ringOk,
    unknown: styles.ringUnknown
  }[tone];
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const fraction = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;

  return (
    <div className={`${styles.ring} ${toneClass}`}>
      <svg className={styles.ringSvg} width="116" height="116" viewBox="0 0 116 116" aria-hidden="true">
        <circle className={styles.ringTrack} cx="58" cy="58" r={radius} fill="none" strokeWidth="8" />
        <circle
          className={styles.ringValue}
          cx="58"
          cy="58"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <span className={styles.ringLabel}>
        <span className={styles.ringScore}>{score == null ? '—' : Math.round(score)}</span>
        <span className={styles.ringCaption}>Experience</span>
      </span>
    </div>
  );
}
