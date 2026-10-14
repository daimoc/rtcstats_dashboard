/**
 * The call list's date filter. The URL carries the *preset id* rather than a
 * frozen timestamp, so "Last 24 hours" still means the last 24 hours when a
 * shared link is opened tomorrow. Only `custom` puts explicit from/to in the URL.
 */
export type RangeId = '24h' | '7d' | '30d' | 'all' | 'custom';

const RANGE_IDS: RangeId[] = ['24h', '7d', '30d', 'all', 'custom'];

export interface RangePreset {
  id: RangeId;
  label: string;
  hours: number | null;
}

export const RANGE_PRESETS: RangePreset[] = [
  { id: '24h', label: 'Last 24 hours', hours: 24 },
  { id: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { id: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { id: 'all', label: 'All time', hours: null }
];

export const DEFAULT_RANGE: RangeId = '24h';

export function isRangeId(value: string | null | undefined): value is RangeId {
  return value != null && (RANGE_IDS as string[]).includes(value);
}

/** The ISO lower bound a preset implies, or undefined when it has none. */
export function presetFrom(id: RangeId, now: number = Date.now()): string | undefined {
  const preset = RANGE_PRESETS.find((p) => p.id === id);
  if (!preset || preset.hours == null) return undefined;
  return new Date(now - preset.hours * 60 * 60 * 1000).toISOString();
}

/** An ISO instant as the `YYYY-MM-DDTHH:mm` a datetime-local input expects. */
export function toLocalInputValue(iso: string | null | undefined, timeZone?: string): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone
  }).formatToParts(new Date(ms));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** The value of a datetime-local input as an ISO instant. */
export function fromLocalInputValue(value: string): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
