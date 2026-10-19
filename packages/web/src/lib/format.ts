export interface FormatOptions {
  locale?: string;
  timeZone?: string;
}

const EM_DASH = '—';

/** Duration in seconds as m:ss, or h:mm:ss once it passes an hour. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return EM_DASH;

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Absolute session start, e.g. "Sep 8, 2026, 14:02". */
export function formatDateTime(iso: string | null | undefined, options: FormatOptions = {}): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return EM_DASH;

  return new Intl.DateTimeFormat(options.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: options.timeZone
  }).format(new Date(ms));
}

/** Coarse "how long ago", for the hover title on a session start. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';

  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Dump size in the largest unit that keeps the number small. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return EM_DASH;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return unit === 0 ? `${value} ${BYTE_UNITS[unit]}` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * A span of milliseconds at the precision it deserves: "420 ms" for set-up steps,
 * "4.2 s" under a minute, then m:ss / h:mm:ss like `formatDuration`.
 */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms / 1000);
}
