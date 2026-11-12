/** Shared formatting. Dates are rendered in the reader's own locale. */

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "3 minutes ago" for recent activity, falling back to a date. */
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return formatDate(iso);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A concentration, as the laboratory writes it.
 *
 * The reference chart is sixteen discrete categories -- 0, 10, 20, 30, 40,
 * 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 1000 ppm -- so a reading
 * taken from it is always a whole number. Postgres stores the column as
 * `numeric(14, 6)` and hands back "350.000000"; anything that forwards that
 * string instead of a number would put "350.000000 ppm" on screen, which
 * reads as six digits of precision the chart does not have.
 *
 * A value that genuinely is not whole is left alone rather than rounded. That
 * can only come from a laboratory measurement entered by hand -- 12.5 ppm
 * from a validated method is a real number and hiding its decimal would be
 * the opposite mistake.
 */
export function formatConcentration(value: number): string {
  if (!Number.isFinite(value)) return '—';
  // Tolerates float noise ("350.0000000001") without touching a real decimal.
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-6 ? String(rounded) : String(value);
}
