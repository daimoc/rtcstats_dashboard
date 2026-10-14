import { fromLocalInputValue, RANGE_PRESETS, toLocalInputValue, type RangeId } from '../lib/dateRange.js';
import styles from './FilterControls.module.css';

export interface DateRangePickerProps {
  range: RangeId;
  from?: string;
  to?: string;
  onChange: (patch: { range: RangeId; from?: string; to?: string }) => void;
}

export function DateRangePicker({ range, from, to, onChange }: DateRangePickerProps) {
  function setCustomBound(bound: 'from' | 'to', inputValue: string) {
    onChange({
      range: 'custom',
      from: bound === 'from' ? fromLocalInputValue(inputValue) : from,
      to: bound === 'to' ? fromLocalInputValue(inputValue) : to
    });
  }

  return (
    <div className={styles.customRange}>
      <div className={styles.segment} role="group" aria-label="Date range">
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`${styles.chip} ${range === preset.id ? styles.chipActive : ''}`}
            aria-pressed={range === preset.id}
            onClick={() => onChange({ range: preset.id, from: undefined, to: undefined })}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          className={`${styles.chip} ${range === 'custom' ? styles.chipActive : ''}`}
          aria-pressed={range === 'custom'}
          onClick={() => onChange({ range: 'custom', from, to })}
        >
          Custom
        </button>
      </div>

      {range === 'custom' && (
        <div className={styles.customRange}>
          <input
            type="datetime-local"
            className={styles.dateInput}
            aria-label="From date"
            value={toLocalInputValue(from)}
            onChange={(e) => setCustomBound('from', e.target.value)}
          />
          <span className={styles.sep}>→</span>
          <input
            type="datetime-local"
            className={styles.dateInput}
            aria-label="To date"
            value={toLocalInputValue(to)}
            onChange={(e) => setCustomBound('to', e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
