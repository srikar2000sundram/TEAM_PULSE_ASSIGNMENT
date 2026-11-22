import { describe, expect, it } from 'vitest';
import { notificationKinds } from '@teampulse/contracts';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';

describe('migrations stay in step with the contracts', () => {
  it('the notification kind constraint lists exactly the contract kinds', () => {
    const sql = MIGRATIONS.map((m) => m.sql).join('\n');
    const list = /notifications_kind_valid\s+CHECK \(kind IN \(([^)]*)\)\)/.exec(sql);
    expect(list, 'constraint notifications_kind_valid not found').not.toBeNull();
    const inDatabase = [...(list?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    // A new kind needs a new migration that widens the constraint.
    expect(inDatabase.sort()).toEqual([...notificationKinds].sort());
  });
});
