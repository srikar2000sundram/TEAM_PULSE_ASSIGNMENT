import { parseEvent } from '@teampulse/contracts';
import { describe, expect, it } from 'vitest';
import { HABIT, USER, activity, id, setup } from '../support/fakes.js';

describe('UpdateStreak', () => {
  it('stores the first streak and publishes StreakUpdated', async () => {
    const { update, state, publisher } = setup();
    const source = activity('2026-11-20');
    await update.execute(source);

    expect(state()).toMatchObject({ currentStreak: 1, longestStreak: 1, version: 1 });
    expect(publisher.published).toHaveLength(1);
    const event = publisher.published[0]!;
    expect(parseEvent(event).success).toBe(true);
    expect(event).toMatchObject({
      eventType: 'StreakUpdated',
      producer: 'streak-lambda',
      correlationId: source.correlationId,
      payload: {
        userId: USER,
        habitId: HABIT,
        currentStreak: 1,
        longestStreak: 1,
        activityDate: '2026-11-20',
      },
    });
  });

  it('builds a streak over consecutive days and restarts after a gap', async () => {
    const { update, state, publisher } = setup();
    for (const day of ['2026-11-18', '2026-11-19', '2026-11-20'])
      await update.execute(activity(day));
    expect(state()).toMatchObject({ currentStreak: 3, longestStreak: 3 });

    await update.execute(activity('2026-11-23'));
    expect(state()).toMatchObject({ currentStreak: 1, longestStreak: 3 });
    expect(
      publisher.published.map((e) => (e.payload as { currentStreak: number }).currentStreak),
    ).toEqual([1, 2, 3, 1]);
  });

  it('keeps separate streaks per habit and per user', async () => {
    const { update, store } = setup();
    await update.execute(activity('2026-11-19'));
    await update.execute(activity('2026-11-20'));
    await update.execute(activity('2026-11-20', { habitId: id(0x52) }));
    await update.execute(activity('2026-11-20', { userId: id(0xb1) }));
    expect(store.items.size).toBe(3);
    expect(store.items.get(`${USER}|${HABIT}`)?.currentStreak).toBe(2);
    expect(store.items.get(`${USER}|${id(0x52)}`)?.currentStreak).toBe(1);
  });

  describe('being safe to run more than once', () => {
    it('a redelivered event leaves the streak unchanged and re-publishes the same event id', async () => {
      const { update, state, publisher } = setup();
      const source = activity('2026-11-20');
      await update.execute(source);
      await update.execute(source);

      expect(state()).toMatchObject({ currentStreak: 1, version: 1 });
      expect(publisher.published).toHaveLength(2);
      expect(publisher.published[1]?.eventId).toBe(publisher.published[0]?.eventId);
    });

    it('announces nothing for a back-dated activity, which changes nothing', async () => {
      const { update, state, publisher } = setup();
      await update.execute(activity('2026-11-20'));
      await update.execute(activity('2026-11-15'));
      expect(state()).toMatchObject({ currentStreak: 1, lastActivityDate: '2026-11-20' });
      expect(publisher.published).toHaveLength(1);
    });

    it('different source events give different StreakUpdated ids', async () => {
      const { update, publisher } = setup();
      await update.execute(activity('2026-11-19'));
      await update.execute(activity('2026-11-20'));
      expect(new Set(publisher.published.map((e) => e.eventId)).size).toBe(2);
    });

    it('a duplicate of an earlier day does not undo later progress', async () => {
      const { update, state } = setup();
      const first = activity('2026-11-19');
      await update.execute(first);
      await update.execute(activity('2026-11-20'));
      await update.execute(first); // redelivered, arrives late
      expect(state()).toMatchObject({ currentStreak: 2, lastActivityDate: '2026-11-20' });
    });

    it('recovers from a crash between saving and publishing: the retry publishes', async () => {
      const { update, state, publisher } = setup();
      const source = activity('2026-11-20');
      publisher.failures = 1;

      await expect(update.execute(source)).rejects.toThrow('bus unreachable');
      expect(state()).toMatchObject({ currentStreak: 1 }); // saved
      expect(publisher.published).toHaveLength(0); // but not announced

      await update.execute(source); // Lambda retries the invocation
      expect(state()).toMatchObject({ currentStreak: 1, version: 1 });
      expect(publisher.published).toHaveLength(1);
      expect(publisher.published[0]?.payload).toMatchObject({ currentStreak: 1 });
    });

    it('fails the invocation when the bus rejects the event, so Lambda retries', async () => {
      const { update, publisher } = setup();
      publisher.rejectWith = 'ThrottlingException';
      await expect(update.execute(activity('2026-11-20'))).rejects.toThrow(/ThrottlingException/);
    });
  });

  describe('concurrent invocations', () => {
    it('re-reads and recomputes when another invocation wrote first', async () => {
      const { update, store, state } = setup();
      await update.execute(activity('2026-11-19'));
      store.conflictsToInject = 1; // someone else bumps the version just before our save
      await update.execute(activity('2026-11-20'));

      expect(state()).toMatchObject({ currentStreak: 2, lastActivityDate: '2026-11-20' });
      expect(store.saveCalls).toBe(3); // first save, the conflicting one, the successful retry
    });

    it('gives up with an error after too many conflicts', async () => {
      const { update, store } = setup({ maxAttempts: 3 });
      await update.execute(activity('2026-11-19'));
      store.conflictsToInject = 10; // every save loses the race
      await expect(update.execute(activity('2026-11-20'))).rejects.toThrow(/kept conflicting/);
    });
  });

  it('does not log user ids', async () => {
    const { update, logs } = setup();
    await update.execute(activity('2026-11-20'));
    expect(logs.join('\n')).toContain('streak.processed');
    expect(logs.join('\n')).not.toContain(USER);
  });
});
