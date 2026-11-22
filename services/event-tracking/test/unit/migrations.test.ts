import { describe, expect, it } from 'vitest';
import { activityTypes } from '@teampulse/contracts';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';

describe('migrations stay in step with the contracts', () => {
  const sql = MIGRATIONS.map((m) => m.sql).join('\n');

  it('every activity type constraint lists exactly the contract activity types', () => {
    const lists = [...sql.matchAll(/activity_type (?:IS NULL OR activity_type )?IN \(([^)]*)\)/g)];
    expect(lists.length, 'expected one constraint on activities and one on known_habits').toBe(2);
    for (const list of lists) {
      const inDatabase = [...(list[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
      // A new activity type needs a new migration that widens the constraint.
      expect(inDatabase.sort()).toEqual([...activityTypes].sort());
    }
  });

  it('caps the team snapshot at the same 20 the access token allows', async () => {
    const { MAX_TEAM_CLAIMS } = await import('@teampulse/contracts');
    expect(sql).toContain(`cardinality(team_ids) <= ${MAX_TEAM_CLAIMS}`);
  });
});
