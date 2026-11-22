/** `YYYY-MM-DD` of a local date. The people using the app think in their own calendar days. */
export function localDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The local date `days` before (or, if negative, after) `from`. */
export function daysAgo(days: number, from: Date = new Date()): string {
  const copy = new Date(from.getFullYear(), from.getMonth(), from.getDate() - days);
  return localDate(copy);
}

/** A friendly message for an error, never a stack or internals. */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.name === 'ApiError') return error.message;
  return 'Something went wrong. Please try again.';
}

export const titleCase = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1).replace(/_/g, ' ');
