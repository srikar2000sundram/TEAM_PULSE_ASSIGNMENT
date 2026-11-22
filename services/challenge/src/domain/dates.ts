const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of an instant, in UTC. Challenges run on UTC calendar days. */
export const dateOf = (instant: Date): string => instant.toISOString().slice(0, 10);

/** The calendar day `days` after (or, if negative, before) `date`. */
export function addDays(date: string, days: number): string {
  return dateOf(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
}

/** Number of calendar days from `from` to `to`, both included. */
export function daysInclusive(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}
