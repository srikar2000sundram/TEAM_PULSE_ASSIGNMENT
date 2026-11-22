import { describe, expect, it } from 'vitest';
import { activityTypes, badgeKinds, challengeStatuses } from '@teampulse/contracts';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';

const sql = MIGRATIONS.map((m) => m.sql).join('\n');

/** The values of `CONSTRAINT <name> CHECK (<column> IN (...))`. */
function allowedValues(constraint: string): string[] {
  const match = new RegExp(`${constraint}\\s+CHECK \\(\\s*\\w+ IN \\(([^)]*)\\)\\)`, 's').exec(sql);
  expect(match, `constraint ${constraint} not found`).not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
}

describe('migrations stay in step with the contracts', () => {
  // A new value needs a new migration that widens the constraint.
  it('the activity types are exactly the contract list', () => {
    expect(allowedValues('challenges_activity_type_valid').sort()).toEqual(
      [...activityTypes].sort(),
    );
  });

  it('the statuses are exactly the contract list', () => {
    expect(allowedValues('challenges_status_valid').sort()).toEqual([...challengeStatuses].sort());
  });

  it('the badge kinds are exactly the contract list', () => {
    expect(allowedValues('badge_rules_kind_valid').sort()).toEqual([...badgeKinds].sort());
  });
});
