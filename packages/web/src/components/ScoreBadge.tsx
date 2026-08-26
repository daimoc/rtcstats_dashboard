export interface ScoreBadgeProps {
  score: number | null;
  worstSeverity: 'critical' | 'warning' | 'info' | null;
}

export function ScoreBadge({ score, worstSeverity }: ScoreBadgeProps) {
  if (score == null) return <span className="score-unknown">—</span>;

  const className =
    worstSeverity === 'critical' || score < 50
      ? 'score-critical'
      : worstSeverity === 'warning' || score < 80
        ? 'score-warning'
        : 'score-ok';

  return <span className={className}>{Math.round(score)}</span>;
}
