import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FilterBar } from '../components/FilterBar.js';
import { SessionTable } from '../components/SessionTable.js';
import { fetchSessions, type SessionFilters, type SessionSummary } from '../lib/api.js';

function filtersFromParams(params: URLSearchParams): SessionFilters {
  const types = params.get('types');
  return {
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    user: params.get('user') ?? undefined,
    conference: params.get('conference') ?? undefined,
    types: types ? types.split(',') : undefined,
    severity: params.get('severity') ?? undefined,
    sort: params.get('sort') === 'score' ? 'score' : 'date',
    limit: 25
  };
}

export function SessionBrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    if (!searchParams.get('from')) {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const next = new URLSearchParams(searchParams);
      next.set('from', from);
      if (!next.get('sort')) next.set('sort', 'date');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filters = filtersFromParams(searchParams);

  useEffect(() => {
    if (!filters.from) return;
    fetchSessions(filters).then((result) => {
      setItems(result.items);
      setNextCursor(result.nextCursor);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  function applyPatch(patch: Partial<SessionFilters>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') next.delete(key);
      else next.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    setSearchParams(next);
  }

  function loadMore() {
    if (!nextCursor) return;
    fetchSessions({ ...filters, cursor: nextCursor }).then((result) => {
      setItems((prev) => [...prev, ...result.items]);
      setNextCursor(result.nextCursor);
    });
  }

  function onChipClick(type: string) {
    const currentTypes = filters.types ?? [];
    if (currentTypes.includes(type)) return;
    applyPatch({ types: [...currentTypes, type] });
  }

  return (
    <div>
      <FilterBar filters={filters} onChange={applyPatch} />
      <SessionTable items={items} onChipClick={onChipClick} />
      {nextCursor && <button onClick={loadMore}>Load more</button>}
    </div>
  );
}
