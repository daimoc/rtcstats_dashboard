import { useEffect, useRef, useState } from 'react';
import styles from './FilterControls.module.css';

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Milliseconds to wait after typing stops before hitting the API. */
  debounceMs?: number;
}

/**
 * One box that searches both the user and the conference. The committed value
 * lives in the URL; this keeps a local draft so typing stays responsive.
 */
export function SearchBar({ value, onChange, debounceMs = 250 }: SearchBarProps) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);

  // Adopt changes that came from elsewhere (back/forward, a cleared filter),
  // without clobbering what the user is currently typing.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      onChange(draft);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [draft, debounceMs, onChange]);

  function clear() {
    committed.current = '';
    setDraft('');
    onChange('');
  }

  return (
    <div className={styles.search}>
      <span className={styles.searchIcon}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        type="search"
        name="q"
        className={styles.searchInput}
        aria-label="Search calls by user or conference"
        placeholder="Search by user or conference…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {draft && (
        <button type="button" className={styles.clear} onClick={clear} aria-label="Clear search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
