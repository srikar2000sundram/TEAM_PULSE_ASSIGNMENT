import { describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import { unwrap, type Result } from '@teampulse/kernel';
import {
  ALICE,
  BOB,
  DATA,
  HABIT,
  OTHER_HABIT,
  PLATFORM,
  TODAY,
  buildHarness,
  principal,
  uuid,
} from '../support/harness.js';

const alice = principal(ALICE, { teams: [PLATFORM, DATA] });
const bob = principal(BOB, { teams: [PLATFORM] });
const errorOf = (result: Result<unknown>) => (result.ok ? undefined : result.error);

describe('RecordActivity', () => {
  it('stores the activity and publishes ActivityCompleted with the team snapshot', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE, HABIT, 'yoga');

    const { activity, created } = unwrap(await h.record(alice));
    expect(created).toBe(true);
    expect(activity).toMatchObject({
      userId: ALICE,
      habitId: HABIT,
      activityType: 'yoga',
      activityDate: TODAY,
    });

    expect(h.outbox()).toHaveLength(1);
    const event = h.outbox()[0]!;
    expect(parseEvent(event).success).toBe(true);
    expect(event).toMatchObject({
      eventType: 'ActivityCompleted',
      producer: 'event-tracking',
      payload: {
        userId: ALICE,
        habitId: HABIT,
        teamIds: [PLATFORM, DATA],
        activityType: 'yoga',
        activityDate: TODAY,
        totalCompleted: 1,
      },
    });
  });

  it('counts the running total, one more for each new day and none for a repeat', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE, HABIT, 'yoga');
    await h.record(alice, TODAY);
    await h.record(alice, TODAY); // a retry: nothing new, no event
    await h.record(alice, '2026-11-19');
    const totals = h.outbox().map((e) => (e.payload as { totalCompleted: number }).totalCompleted);
    expect(totals).toEqual([1, 2]);
  });

  it('takes the activity type from the habit, never from the client', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE, HABIT, 'cycling');
    const { activity } = unwrap(await h.record(alice));
    expect(activity.activityType).toBe('cycling');
  });

  it('is idempotent: recording the same habit and day again stores and publishes nothing new', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE);
    const first = unwrap(await h.record(alice));
    h.clock.advanceMs(60_000);
    const second = unwrap(await h.record(alice));

    expect(second.created).toBe(false);
    expect(second.activity.id).toBe(first.activity.id);
    expect(h.uow.store.activities.size).toBe(1);
    expect(h.outbox()).toHaveLength(1); // the streak must not count the day twice
  });

  it('treats different days and different habits as separate activities', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE, HABIT);
    await h.knowHabit(ALICE, OTHER_HABIT, 'running');
    unwrap(await h.record(alice, TODAY));
    unwrap(await h.record(alice, '2026-11-19'));
    unwrap(await h.record(alice, TODAY, OTHER_HABIT));
    expect(h.uow.store.activities.size).toBe(3);
    expect(h.outbox()).toHaveLength(3);
  });

  it('two users completing their own habits on the same day do not collide', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE, HABIT);
    await h.knowHabit(BOB, OTHER_HABIT);
    expect(unwrap(await h.record(alice)).created).toBe(true);
    expect(unwrap(await h.record(bob, TODAY, OTHER_HABIT)).created).toBe(true);
  });

  it('refuses someone else’s habit with the same 404 as an unknown one', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE);
    const theirs = await h.record(bob);
    const unknown = await h.record(bob, TODAY, uuid(0x999));
    expect(errorOf(theirs)).toEqual(errorOf(unknown));
    expect(errorOf(theirs)).toMatchObject({ kind: 'not_found', code: 'habit.not_found' });
    expect(h.uow.store.activities.size).toBe(0);
    expect(h.outbox()).toHaveLength(0);
  });

  it('a habit whose creation event has not arrived yet is "not found": a retry will succeed', async () => {
    const h = buildHarness();
    expect(errorOf(await h.record(alice))?.code).toBe('habit.not_found');
    await h.knowHabit(ALICE);
    expect((await h.record(alice)).ok).toBe(true);
  });

  it('refuses an archived habit', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE);
    unwrap(
      await h.app.applyHabitArchived.execute({
        habitId: HABIT,
        ownerUserId: ALICE,
        occurredAt: new Date('2026-11-10T08:00:00Z'),
      }),
    );
    expect(errorOf(await h.record(alice))).toMatchObject({
      kind: 'conflict',
      code: 'habit.archived',
    });
  });

  it('validates the date window before touching anything', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE);
    expect(errorOf(await h.record(alice, '2026-12-25'))?.code).toBe('activity.date_in_future');
    expect(errorOf(await h.record(alice, '2026-10-01'))?.code).toBe('activity.date_too_old');
    expect(h.uow.store.activities.size).toBe(0);
  });

  it('snapshots the teams at the time of the activity, not later', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE);
    unwrap(await h.record(principal(ALICE, { teams: [PLATFORM] }), TODAY));
    unwrap(await h.record(principal(ALICE, { teams: [DATA] }), '2026-11-19'));
    const payloads = h.outbox().map((e) => (e.payload as { teamIds: string[] }).teamIds);
    expect(payloads).toEqual([[PLATFORM], [DATA]]);
  });

  it('logs without raw user ids', async () => {
    const h = buildHarness();
    await h.knowHabit(ALICE);
    unwrap(await h.record(alice));
    const logs = h.logLines.join('\n');
    expect(logs).toContain('activity.recorded');
    expect(logs).not.toContain(ALICE);
  });
});

describe('ListActivities', () => {
  async function seed() {
    const h = buildHarness();
    await h.knowHabit(ALICE, HABIT);
    await h.knowHabit(BOB, OTHER_HABIT, 'running');
    for (const day of ['2026-11-18', '2026-11-19', '2026-11-20']) {
      unwrap(await h.record(alice, day));
      h.clock.advanceMs(1000);
    }
    unwrap(await h.record(bob, TODAY, OTHER_HABIT));
    return h;
  }

  it('lists only the caller’s own activities, newest recorded first', async () => {
    const h = await seed();
    const page = unwrap(await h.app.listActivities.execute({ actor: alice, limit: 10 }));
    expect(page.items.map((a) => a.activityDate)).toEqual([
      '2026-11-20',
      '2026-11-19',
      '2026-11-18',
    ]);
    expect(page.items.every((a) => a.userId === ALICE)).toBe(true);
  });

  it('filters by date range and habit', async () => {
    const h = await seed();
    const ranged = unwrap(
      await h.app.listActivities.execute({
        actor: alice,
        from: '2026-11-19',
        to: '2026-11-19',
        limit: 10,
      }),
    );
    expect(ranged.items.map((a) => a.activityDate)).toEqual(['2026-11-19']);

    const otherHabit = unwrap(
      await h.app.listActivities.execute({ actor: alice, habitId: OTHER_HABIT, limit: 10 }),
    );
    expect(otherHabit.items).toEqual([]);
  });

  it('pages without skipping or repeating', async () => {
    const h = await seed();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = unwrap(await h.app.listActivities.execute({ actor: alice, limit: 2, cursor }));
      seen.push(...page.items.map((a) => a.activityDate));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(['2026-11-20', '2026-11-19', '2026-11-18']);
  });

  it('rejects a malformed cursor', async () => {
    const h = buildHarness();
    const result = await h.app.listActivities.execute({ actor: alice, limit: 10, cursor: 'junk' });
    expect(errorOf(result)).toMatchObject({ kind: 'validation', code: 'cursor.invalid' });
  });
});
