import { migrate } from '@teampulse/db';
import { PgliteDatabase } from '@teampulse/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';
import { PostgresUnitOfWork } from '../../src/adapters/persistence/repositories.js';

const db = new PgliteDatabase();
const uow = new PostgresUnitOfWork(db);
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, MIGRATIONS);
});
afterAll(() => db.close());

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ALICE = uuid(0xa1);
const BOB = uuid(0xb1);
const WALK = uuid(0x51);
const NOW = new Date('2026-11-20T08:00:00Z');

describe('activity times', () => {
  it('stores a completion once per event, however often it arrives', async () => {
    const entry = { eventId: uuid(1), userId: ALICE, habitId: WALK, occurredAt: NOW };
    expect(await uow.run((tx) => tx.activityTimes.record(entry))).toBe(true);
    expect(await uow.run((tx) => tx.activityTimes.record(entry))).toBe(false);
    const stored = await uow.run((tx) => tx.activityTimes.listSince(ALICE, new Date(0)));
    expect(stored).toEqual([{ habitId: WALK, occurredAt: NOW }]);
  });

  it("lists only the given person's completions, from the given date", async () => {
    await uow.run(async (tx) => {
      await tx.activityTimes.record({
        eventId: uuid(1),
        userId: ALICE,
        habitId: WALK,
        occurredAt: new Date('2026-11-01T06:00:00Z'),
      });
      await tx.activityTimes.record({
        eventId: uuid(2),
        userId: ALICE,
        habitId: WALK,
        occurredAt: new Date('2026-11-10T06:00:00Z'),
      });
      await tx.activityTimes.record({
        eventId: uuid(3),
        userId: BOB,
        habitId: WALK,
        occurredAt: new Date('2026-11-10T06:00:00Z'),
      });
    });
    const list = await uow.run((tx) =>
      tx.activityTimes.listSince(ALICE, new Date('2026-11-05T00:00:00Z')),
    );
    expect(list.map((entry) => entry.occurredAt.toISOString())).toEqual([
      '2026-11-10T06:00:00.000Z',
    ]);
  });

  it('forgets old completions', async () => {
    await uow.run(async (tx) => {
      await tx.activityTimes.record({
        eventId: uuid(1),
        userId: ALICE,
        habitId: WALK,
        occurredAt: new Date('2026-01-01T06:00:00Z'),
      });
      await tx.activityTimes.record({
        eventId: uuid(2),
        userId: ALICE,
        habitId: WALK,
        occurredAt: NOW,
      });
    });
    expect(
      await uow.run((tx) => tx.activityTimes.purgeBefore(new Date('2026-06-01T00:00:00Z'))),
    ).toBe(1);
    expect(await uow.run((tx) => tx.activityTimes.listSince(ALICE, new Date(0)))).toHaveLength(1);
  });

  it('erases everything about one person and nobody else', async () => {
    await uow.run(async (tx) => {
      await tx.activityTimes.record({
        eventId: uuid(1),
        userId: ALICE,
        habitId: WALK,
        occurredAt: NOW,
      });
      await tx.activityTimes.record({
        eventId: uuid(2),
        userId: BOB,
        habitId: WALK,
        occurredAt: NOW,
      });
    });
    expect(await uow.run((tx) => tx.activityTimes.deleteAllForUser(ALICE))).toBe(1);
    expect(await uow.run((tx) => tx.activityTimes.listSince(BOB, new Date(0)))).toHaveLength(1);
  });
});

describe('decisions', () => {
  const decision = {
    userId: ALICE,
    habitId: WALK,
    suggestedTime: '07:00',
    timeZone: 'UTC',
    decision: 'accepted' as const,
  };

  it('saves a decision and replaces it when the person changes their mind', async () => {
    await uow.run((tx) => tx.decisions.save(decision, NOW));
    await uow.run((tx) => tx.decisions.save({ ...decision, decision: 'dismissed' }, NOW));
    const list = await uow.run((tx) => tx.decisions.listForUser(ALICE));
    expect(list).toEqual([{ ...decision, decision: 'dismissed' }]);
  });

  it('keeps decisions per person', async () => {
    await uow.run((tx) => tx.decisions.save(decision, NOW));
    expect(await uow.run((tx) => tx.decisions.listForUser(BOB))).toEqual([]);
  });

  it('erases a person’s decisions', async () => {
    await uow.run((tx) => tx.decisions.save(decision, NOW));
    expect(await uow.run((tx) => tx.decisions.deleteAllForUser(ALICE))).toBe(1);
  });

  it('the schema rejects an unknown decision and a malformed time', async () => {
    const insert = (decisionValue: string, time: string) =>
      db.query(
        `INSERT INTO decisions (user_id, habit_id, suggested_time, time_zone, decision, decided_at)
         VALUES ($1, $2, $3, 'UTC', $4, now())`,
        [ALICE, WALK, time, decisionValue],
      );
    await expect(insert('maybe', '07:00')).rejects.toThrow(/decisions_decision_valid/);
    await expect(insert('accepted', '7:00')).rejects.toThrow(/decisions_time_format/);
    await expect(insert('accepted', '23:00')).resolves.toBeDefined();
  });
});
