/**
 * K-anonymity for aggregates (ADR-0005): a number about a group is shown only when enough people
 * stand behind it that it cannot be traced to one of them.
 *
 * Two rules, both enforced here so no service has to remember them:
 * 1. **Small cohorts are suppressed.** A cell backed by fewer than K people is hidden.
 * 2. **Hidden cells cannot be recovered by subtraction.** If a total is shown together with its
 *    breakdown, and exactly one part is hidden, `total - (the visible parts)` reveals it. So another
 *    part is hidden as well ("complementary suppression"), leaving at least two unknowns.
 */

/** Smallest K a deployment may configure. K of 1 or 2 hides almost nothing. */
export const MIN_ALLOWED_COHORT_SIZE = 3;
export const DEFAULT_MIN_COHORT_SIZE = 5;

/** Validates a configured K: a whole number, at least `MIN_ALLOWED_COHORT_SIZE`. */
export function assertValidCohortSize(k: number): number {
  if (!Number.isInteger(k) || k < MIN_ALLOWED_COHORT_SIZE) {
    throw new RangeError(
      `The minimum cohort size must be a whole number of at least ${MIN_ALLOWED_COHORT_SIZE}`,
    );
  }
  return k;
}

/** A number and how many distinct people contributed to it. */
export interface Measure {
  readonly value: number;
  readonly cohortSize: number;
}

export type SuppressionReason = 'cohort_too_small' | 'complementary';

/** What is allowed to leave the service. A suppressed cell carries no number and no size. */
export type Released =
  | { readonly suppressed: false; readonly value: number; readonly cohortSize: number }
  | { readonly suppressed: true; readonly reason: SuppressionReason };

const shown = (measure: Measure): Released => ({
  suppressed: false,
  value: measure.value,
  cohortSize: measure.cohortSize,
});

const hidden = (reason: SuppressionReason): Released => ({ suppressed: true, reason });

/** Releases one measure, or suppresses it when fewer than `k` people are behind it. */
export function release(measure: Measure, k: number = DEFAULT_MIN_COHORT_SIZE): Released {
  assertValidCohortSize(k);
  return measure.cohortSize >= k ? shown(measure) : hidden('cohort_too_small');
}

export interface Breakdown<Key extends string> {
  readonly total: Released;
  readonly parts: Readonly<Record<Key, Released>>;
}

export interface BreakdownOptions {
  readonly k?: number;
  /**
   * True when the parts add up to the total (for example completions by activity type), which is
   * what makes subtraction possible. Set false only for parts that overlap or do not cover the
   * whole; the default assumes the worst.
   */
  readonly exhaustive?: boolean;
}

/**
 * Releases a total together with its parts, applying both rules.
 *
 * - A total with fewer than `k` people hides everything: no part can have more people than the whole.
 * - Parts below `k` are hidden.
 * - If the parts are exhaustive and exactly one is hidden, the smallest visible part is hidden too
 *   (ties broken by key, so the result is deterministic). If there is no visible part to hide, the
 *   total is hidden instead, since it would equal the hidden part.
 */
export function releaseBreakdown<Key extends string>(
  total: Measure,
  parts: Readonly<Record<Key, Measure>>,
  options: BreakdownOptions = {},
): Breakdown<Key> {
  const k = assertValidCohortSize(options.k ?? DEFAULT_MIN_COHORT_SIZE);
  const keys = (Object.keys(parts) as Key[]).sort();

  if (total.cohortSize < k) {
    return {
      total: hidden('cohort_too_small'),
      parts: Object.fromEntries(keys.map((key) => [key, hidden('cohort_too_small')])) as Record<
        Key,
        Released
      >,
    };
  }

  const releasedParts = Object.fromEntries(
    keys.map((key) => [key, release(parts[key], k)]),
  ) as Record<Key, Released>;
  let releasedTotal = shown(total);

  const exhaustive = options.exhaustive ?? true;
  const hiddenKeys = keys.filter((key) => releasedParts[key].suppressed);

  if (exhaustive && hiddenKeys.length === 1) {
    const visibleKeys = keys.filter((key) => !releasedParts[key].suppressed);
    const smallest = visibleKeys.reduce<Key | undefined>(
      (best, key) =>
        best === undefined || parts[key].cohortSize < parts[best].cohortSize ? key : best,
      undefined,
    );
    if (smallest === undefined) {
      releasedTotal = hidden('complementary');
    } else {
      releasedParts[smallest] = hidden('complementary');
    }
  }

  return { total: releasedTotal, parts: releasedParts };
}
