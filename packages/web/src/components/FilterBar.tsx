import type { ChangeEvent } from 'react';
import type { SessionFilters } from '../lib/api.js';

export interface FilterBarProps {
  filters: SessionFilters;
  onChange: (patch: Partial<SessionFilters>) => void;
}

export function FilterBar({ filters, onChange }: FilterBarProps) {
  function textField(name: 'user' | 'conference', label: string) {
    return (
      <label>
        {label}
        <input
          id={label}
          aria-label={label}
          value={filters[name] ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ [name]: e.target.value || undefined })}
        />
      </label>
    );
  }

  return (
    <div>
      {textField('user', 'User')}
      {textField('conference', 'Conference')}
      <label>
        Severity
        <select
          aria-label="Severity"
          value={filters.severity ?? ''}
          onChange={(e) => onChange({ severity: e.target.value || undefined })}
        >
          <option value="">Any</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </label>
      {filters.sort === 'score' ? (
        <button onClick={() => onChange({ sort: 'date' })}>Newest first</button>
      ) : (
        <button onClick={() => onChange({ sort: 'score' })}>Worst first</button>
      )}
    </div>
  );
}
