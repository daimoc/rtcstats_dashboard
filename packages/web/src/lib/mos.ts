export type MosTone = 'critical' | 'warning' | 'ok' | 'unknown';

/**
 * Severity band for a MOS, following the G.107 user-satisfaction bands: from R = 80
 * (MOS ≈ 4.0) users are satisfied, below R = 60 (MOS ≈ 3.1) nearly all are dissatisfied.
 */
export function mosTone(mos: number | null | undefined): MosTone {
  if (mos == null || !Number.isFinite(mos)) return 'unknown';
  if (mos < 3.1) return 'critical';
  if (mos < 4) return 'warning';
  return 'ok';
}

/** One decimal: MOS differences below 0.1 are noise. */
export function formatMos(mos: number | null | undefined): string {
  return mos == null || !Number.isFinite(mos) ? '—' : mos.toFixed(1);
}

/** Choices for the call-list MOS filter: calls whose worse MOS is at or below the value. */
export const MOS_FILTERS = [
  { value: '', label: 'Any MOS' },
  { value: '4', label: 'MOS ≤ 4.0' },
  { value: '3.5', label: 'MOS ≤ 3.5' },
  { value: '3', label: 'MOS ≤ 3.0' },
  { value: '2.5', label: 'MOS ≤ 2.5' }
];
