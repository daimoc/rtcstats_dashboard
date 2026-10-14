import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FilterBar } from '../components/FilterBar.js';
import { SessionTable } from '../components/SessionTable.js';
import { fetchSessions, type SessionFilters, type SessionSummary } from '../lib/api.js';
import { DEFAULT_RANGE, isRangeId, presetFrom, type RangeId } from '../lib/dateRange.js';
import styles from './SessionBrowserPage.module.css';

const PAGE_SIZE = 25;

function rangeFromParams(params: URLSearchParams): RangeId {
  const raw = params.get('range');
  return isRangeId(raw) ? raw : DEFAULT_RANGE;
}

function filtersFromParams(params: URLSearchParams): SessionFilters {
  const range = rangeFromParams(params);
  const types = params.get('types');
  const maxMos = Number(params.get('maxMos') || NaN);

  // A preset means "relative to now", so it is resolved on read rather than
  // frozen into the URL; only a custom range carries explicit bounds.
  const from = range === 'custom' ? (params.get('from') ?? undefined) : presetFrom(range);
  const to = range === 'custom' ? (params.get('to') ?? undefined) : undefined;

  return {
    from,
    to,
    q: params.get('q') ?? undefined,
    types: types ? types.split(',') : undefined,
    severity: params.get('severity') ?? undefined,
    maxMos: Number.isFinite(maxMos) ? maxMos : undefined,
    sort: params.get('sort') === 'score' ? 'score' : 'date',
    limit: PAGE_SIZE
  };
}

export function SessionBrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paramsKey = searchParams.toString();
  const filters = useMemo(() => filtersFromParams(new URLSearchParams(paramsKey)), [paramsKey]);
  const range = rangeFromParams(searchParams);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSessions(filters)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setItems([]);
        setNextCursor(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters]);

  const applyPatch = useCallback(
    (patch: Record<string, unknown>) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value == null || value === '') next.delete(key);
          else next.set(key, Array.isArray(value) ? value.join(',') : String(value));
        }
        // Presets recompute their bounds on read, so stale ones must not linger.
        if (patch.range != null && patch.range !== 'custom') {
          next.delete('from');
          next.delete('to');
        }
        return next;
      });
    },
    [setSearchParams]
  );

  function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    fetchSessions({ ...filters, cursor: nextCursor })
      .then((result) => {
        setItems((prev) => [...prev, ...result.items]);
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingMore(false));
  }

  const activeTypes = filters.types ?? [];

  function toggleType(type: string) {
    const next = activeTypes.includes(type)
      ? activeTypes.filter((t) => t !== type)
      : [...activeTypes, type];
    applyPatch({ types: next.length > 0 ? next : undefined });
  }

  return (
    <>
      <div className={styles.head}>
        <h1 className={styles.title}>Calls</h1>
        {!loading && !error && (
          <span className={styles.count}>
            {items.length}{nextCursor ? '+' : ''} {items.length === 1 ? 'call' : 'calls'}
          </span>
        )}
      </div>

      <FilterBar filters={filters} range={range} onChange={applyPatch} />

      {activeTypes.length > 0 && (
        <div className={styles.activeTypes}>
          <span className={styles.activeLabel}>Issue filters:</span>
          {activeTypes.map((type) => (
            <span key={type} className={styles.typeChip}>
              {type}
              <button
                type="button"
                className={styles.typeChipRemove}
                aria-label={`Remove ${type} filter`}
                onClick={() => toggleType(type)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      <SessionTable
        items={items}
        loading={loading}
        error={error}
        onChipClick={toggleType}
        detailSearch={paramsKey ? `?${paramsKey}` : ''}
      />

      {!error && items.length > 0 && (
        <div className={styles.footer}>
          {nextCursor ? (
            <button type="button" className={styles.loadMore} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : (
            <span className={styles.end}>End of results</span>
          )}
        </div>
      )}
    </>
  );
}
