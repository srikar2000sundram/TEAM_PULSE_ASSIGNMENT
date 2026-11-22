import type { ActivityType } from '@teampulse/contracts';
import { releaseBreakdown, type Measure, type Released } from '@teampulse/privacy';

/**
 * What one scope stored for one day and one activity type. `participants` are pseudonyms of the
 * people behind `completions`: enough to count different people, useless for finding out who.
 */
export interface CellData {
  readonly day: string;
  readonly activityType: ActivityType;
  readonly completions: number;
  readonly participants: readonly string[];
}

export interface TeamReportData {
  readonly total: Released;
  /** Only types that have data. */
  readonly byActivityType: Partial<Record<ActivityType, Released>>;
  /** Only days that have data, oldest first. */
  readonly byDay: readonly { readonly date: string; readonly cell: Released }[];
}

interface Tally {
  completions: number;
  people: Set<string>;
}

const newTally = (): Tally => ({ completions: 0, people: new Set() });

function addTo(tally: Tally, cell: CellData): void {
  tally.completions += cell.completions;
  for (const person of cell.participants) tally.people.add(person);
}

const measureOf = (tally: Tally): Measure => ({
  value: tally.completions,
  cohortSize: tally.people.size,
});

function groupBy<Key extends string>(
  cells: readonly CellData[],
  keyOf: (cell: CellData) => Key,
): Record<Key, Measure> {
  const tallies = new Map<Key, Tally>();
  for (const cell of cells) {
    const key = keyOf(cell);
    const tally = tallies.get(key) ?? newTally();
    addTo(tally, cell);
    tallies.set(key, tally);
  }
  return Object.fromEntries([...tallies].map(([key, tally]) => [key, measureOf(tally)])) as Record<
    Key,
    Measure
  >;
}

const hidden = (reason: 'cohort_too_small' | 'complementary'): Released => ({
  suppressed: true,
  reason,
});

/**
 * Turns stored cells into what a manager may see, applying the privacy rules of
 * ADR-0005 (privacy by design):
 *
 * - every number is released only if at least `k` different people stand behind it;
 * - a breakdown never leaves exactly one hidden number that could be worked out by subtraction
 *   (`@teampulse/privacy` hides a second one);
 * - if the total is hidden, every part is hidden with it: visible parts would add up to it.
 *
 * Only parts that have data are listed. An absent type or day is not a hidden zero: counting an
 * empty part as "hidden" would let a reader subtract the visible numbers and recover the one real
 * hidden part, which is the attack complementary suppression exists to prevent.
 */
export function buildTeamReport(cells: readonly CellData[], k: number): TeamReportData {
  const usable = cells.filter((cell) => cell.completions > 0 && cell.participants.length > 0);

  const all = newTally();
  for (const cell of usable) addTo(all, cell);
  const total = measureOf(all);

  const types = groupBy(usable, (cell) => cell.activityType);
  const days = groupBy(usable, (cell) => cell.day);

  const byType = releaseBreakdown(total, types, { k, exhaustive: true });
  const byDay = releaseBreakdown(total, days, { k, exhaustive: true });

  // Both breakdowns start from the same total, so they agree about whether it is shown. A hidden
  // total hides every part with it (done by the privacy package), because visible parts would add up to it.
  return {
    total: byType.total,
    byActivityType: byType.parts,
    byDay: Object.keys(byDay.parts)
      .sort()
      .map((date) => ({ date, cell: byDay.parts[date] ?? hidden('cohort_too_small') })),
  };
}

/** One person's activity on one day and type, as stored in their personal counters. */
export interface PersonalDay {
  readonly day: string;
  readonly activityType: ActivityType;
  readonly completions: number;
  /** Keys of the scopes this activity was also counted in (needed to take it back out). */
  readonly scopeKeys: readonly string[];
  /** When the database deletes these counters (retention). */
  readonly expiresAt: Date;
}

export interface PersonalReportData {
  readonly total: number;
  readonly byActivityType: Partial<Record<ActivityType, number>>;
  readonly byDay: readonly { readonly date: string; readonly completions: number }[];
}

/** Your own numbers: nothing is hidden, because they are about you alone. */
export function buildPersonalReport(days: readonly PersonalDay[]): PersonalReportData {
  const byType: Partial<Record<ActivityType, number>> = {};
  const byDate = new Map<string, number>();
  let total = 0;
  for (const entry of days) {
    if (entry.completions <= 0) continue;
    total += entry.completions;
    byType[entry.activityType] = (byType[entry.activityType] ?? 0) + entry.completions;
    byDate.set(entry.day, (byDate.get(entry.day) ?? 0) + entry.completions);
  }
  return {
    total,
    byActivityType: byType,
    byDay: [...byDate]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, completions]) => ({ date, completions })),
  };
}
