import { describe, expect, it } from 'vitest';
import { activityTypes } from '@teampulse/contracts';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';

describe('migrations stay in step with the contracts', () => {
  it('the activity type CHECK constraint lists exactly the contract activity types', () => {
    const sql = MIGRATIONS.map((m) => m.sql).join('\n');
    const list = /habits_activity_type_valid CHECK \(activity_type IN \(([^)]*)\)\)/.exec(sql);
    expect(list, 'constraint habits_activity_type_valid not found').not.toBeNull();
    const inDatabase = [...(list?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    // A new activity type needs a new migration that widens the constraint.
    expect(inDatabase.sort()).toEqual([...activityTypes].sort());
  });

  it('the length constraints match the contract limits', async () => {
    const { HABIT_DESCRIPTION_MAX_LENGTH, HABIT_TITLE_MAX_LENGTH } =
      await import('@teampulse/contracts');
    const sql = MIGRATIONS.map((m) => m.sql).join('\n');
    expect(sql).toContain(`BETWEEN 1 AND ${HABIT_TITLE_MAX_LENGTH}`);
    expect(sql).toContain(`<= ${HABIT_DESCRIPTION_MAX_LENGTH}`);
  });
});
