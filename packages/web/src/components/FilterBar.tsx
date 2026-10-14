import type { SessionFilters } from '../lib/api.js';
import type { RangeId } from '../lib/dateRange.js';
import { MOS_FILTERS } from '../lib/mos.js';
import { DateRangePicker } from './DateRangePicker.js';
import { SearchBar } from './SearchBar.js';
import styles from './FilterControls.module.css';

export interface FilterBarProps {
  filters: SessionFilters;
  range: RangeId;
  onChange: (patch: Record<string, unknown>) => void;
}

const SEVERITIES = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' }
];

export function FilterBar({ filters, range, onChange }: FilterBarProps) {
  return (
    <div className={styles.toolbar}>
      <div className={`${styles.toolbarRow} ${styles.grow}`}>
        <SearchBar value={filters.q ?? ''} onChange={(q) => onChange({ q: q || undefined })} />
      </div>

      <div className={styles.toolbarRow}>
        <DateRangePicker
          range={range}
          from={filters.from}
          to={filters.to}
          onChange={(patch) => onChange(patch)}
        />

        <select
          className={styles.select}
          aria-label="Severity"
          value={filters.severity ?? ''}
          onChange={(e) => onChange({ severity: e.target.value || undefined })}
        >
          {SEVERITIES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <select
          className={styles.select}
          aria-label="MOS"
          value={filters.maxMos != null ? String(filters.maxMos) : ''}
          onChange={(e) => onChange({ maxMos: e.target.value || undefined })}
        >
          {MOS_FILTERS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>

        <div className={styles.segment} role="group" aria-label="Sort order">
          <button
            type="button"
            className={`${styles.chip} ${filters.sort === 'date' ? styles.chipActive : ''}`}
            aria-pressed={filters.sort === 'date'}
            onClick={() => onChange({ sort: 'date' })}
          >
            Newest first
          </button>
          <button
            type="button"
            className={`${styles.chip} ${filters.sort === 'score' ? styles.chipActive : ''}`}
            aria-pressed={filters.sort === 'score'}
            onClick={() => onChange({ sort: 'score' })}
          >
            Worst first
          </button>
        </div>
      </div>
    </div>
  );
}
