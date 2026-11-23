import type { RecommendationConfidence } from '@teampulse/contracts';

/**
 * Fewer completions than this and there is no pattern worth a suggestion. Five is also the
 * smallest number that can pass the share test below with a clear majority hour.
 */
export const MIN_SAMPLES = 5;

/** The suggested hour must hold at least this share of the completions, or the habit has no clear time. */
export const MIN_SHARE = 0.4;

/** Only the recent past counts: habits drift, and old behaviour should not outvote new. */
export const LOOKBACK_DAYS = 60;

export interface TimingSuggestion {
  /** 0 to 23, in the person's time zone. */
  readonly hour: number;
  /** `HH:00`, the start of that hour. */
  readonly suggestedTime: string;
  readonly sampleSize: number;
  readonly matching: number;
  readonly confidence: RecommendationConfidence;
}

/** The wall-clock hour (0 to 23) at an instant in a time zone. The platform handles daylight saving. */
export function localHour(instant: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(instant)
    .find((entry) => entry.type === 'hour');
  return Number(part?.value ?? '0');
}

const confidenceOf = (share: number): RecommendationConfidence =>
  share >= 0.7 ? 'high' : share >= 0.5 ? 'medium' : 'low';

/**
 * When in the day does this person usually do this habit? Counts completions per local hour and
 * suggests the busiest hour, if there is enough history and one hour clearly stands out. Ties go to
 * the earlier hour, so the answer never depends on the order the data arrived in.
 *
 * Pure: the same completions and zone always give the same answer, which is what makes it testable.
 */
export function suggestTime(
  completions: readonly Date[],
  timeZone: string,
): TimingSuggestion | null {
  if (completions.length < MIN_SAMPLES) return null;

  const perHour = new Array<number>(24).fill(0);
  for (const instant of completions) {
    const hour = localHour(instant, timeZone);
    perHour[hour] = (perHour[hour] ?? 0) + 1;
  }

  let best = 0;
  for (let hour = 1; hour < 24; hour += 1) {
    if ((perHour[hour] ?? 0) > (perHour[best] ?? 0)) best = hour;
  }

  const matching = perHour[best] ?? 0;
  const share = matching / completions.length;
  if (share < MIN_SHARE) return null;

  return {
    hour: best,
    suggestedTime: `${String(best).padStart(2, '0')}:00`,
    sampleSize: completions.length,
    matching,
    confidence: confidenceOf(share),
  };
}
