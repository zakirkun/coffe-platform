const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago" / "in 2 hours"; anything under a minute is "just now". */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const delta = new Date(iso).getTime() - now;
  if (Number.isNaN(delta)) return iso;
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= size) return relativeFormat.format(Math.round(delta / size), unit);
  }
  return 'just now';
}

/** `850ms`, `12.4s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}

/** `mm:ss` for the pairing-token expiry countdown. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** `950`, `12.3K`, `4.1M`. */
export function formatTokens(count: number): string {
  return compactNumber.format(count);
}

export function formatCostUsd(cost: number): string {
  return `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
