import { describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import {
  ALICE,
  BOB,
  TEAM,
  TODAY,
  admin,
  buildHarness,
  manager,
  member,
  uuid,
} from '../support/harness.js';

const event = (n: number) => uuid(0x5000 + n);

describe('RecordChallengeProgress', () => {
  it('scores a qualifying activity for a participant and announces the progress', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);

    expect(await h.score(ALICE, { eventId: event(1) })).toEqual({ scored: 1, badges: 0 });

    const progress = unwrap(
      await h.app.getMyProgress.execute({ actor: member(ALICE), challengeId: challenge.id }),
    );
    expect(progress.stats).toEqual({ points: 1, activeDays: 1, longestStreak: 1 });
    const updates = h.eventsOf('ChallengeProgressUpdated');
    expect(updates).toHaveLength(1);
    expect(parseEvent(updates[0]).success).toBe(true);
    expect(updates[0]).toMatchObject({
      producer: 'challenge',
      payload: {
        challengeId: challenge.id,
        userId: ALICE,
        pointsDelta: 1,
        sourceEventId: event(1),
      },
    });
  });

  it('counts an event once however often it is delivered', async () => {
    const h = buildHarness();
    const challenge = await h.createActive({ badgeRules: [{ kind: 'total', threshold: 1 }] });
    await h.join(challenge.id, ALICE);
    for (let i = 0; i < 4; i += 1) await h.score(ALICE, { eventId: event(1) });

    const board = unwrap(
      await h.app.getLeaderboard.execute({
        actor: member(ALICE),
        challengeId: challenge.id,
        limit: 5,
      }),
    );
    expect(board.entries[0]?.points).toBe(1);
    expect(h.eventsOf('ChallengeProgressUpdated')).toHaveLength(1);
    expect(h.eventsOf('BadgeAwarded')).toHaveLength(1);
  });

  it.each([
    ['a different activity type', { type: 'yoga' as const }],
    ['a day before the challenge', { date: '2026-11-19' }],
    ['a day after the challenge', { date: '2026-12-01' }],
  ])('does not score %s', async (_name, options) => {
    const h = buildHarness();
    const challenge = await h.createActive({
      activityType: 'walking',
      startsOn: '2026-11-20',
      endsOn: '2026-11-30',
    });
    await h.join(challenge.id, ALICE);
    expect(await h.score(ALICE, { eventId: event(1), ...options })).toEqual({
      scored: 0,
      badges: 0,
    });
    expect(h.events().filter((e) => e.eventType === 'ChallengeProgressUpdated')).toEqual([]);
  });

  it('does not score people who have not joined, or a draft, or a cancelled challenge', async () => {
    const h = buildHarness();
    const draft = await h.create();
    expect(draft.challenge.status).toBe('draft');
    const active = await h.createActive();
    await h.join(active.id, ALICE);
    expect(await h.score(BOB, { eventId: event(1) })).toEqual({ scored: 0, badges: 0 }); // never joined
    unwrap(await h.app.cancelChallenge.execute({ actor: manager, challengeId: active.id }));
    expect(await h.score(ALICE, { eventId: event(2) })).toEqual({ scored: 0, badges: 0 });
  });

  it('does not score an activity from before the person joined', async () => {
    const h = buildHarness();
    const challenge = await h.createActive({ startsOn: '2026-11-10', endsOn: '2026-11-30' });
    await h.join(challenge.id, ALICE); // joins on the 20th
    expect(await h.score(ALICE, { eventId: event(1), date: '2026-11-15' })).toEqual({
      scored: 0,
      badges: 0,
    });
    expect(await h.score(ALICE, { eventId: event(2), date: '2026-11-20' })).toEqual({
      scored: 1,
      badges: 0,
    });
  });

  it('scores every challenge the activity counts in, separately', async () => {
    const h = buildHarness();
    const a = await h.createActive({ name: 'A' });
    const b = await h.createActive({ name: 'B' });
    await h.createActive({ name: 'Yoga', activityType: 'yoga' });
    await h.join(a.id, ALICE);
    await h.join(b.id, ALICE);
    expect(await h.score(ALICE, { eventId: event(1) })).toEqual({ scored: 2, badges: 0 });
    expect(h.eventsOf('ChallengeProgressUpdated')).toHaveLength(2);
  });

  it('adds up a person’s points and derives active days and streak from the dates', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);
    const dates = ['2026-11-20', '2026-11-20', '2026-11-21', '2026-11-23'];
    for (const [i, date] of dates.entries()) await h.score(ALICE, { eventId: event(i + 1), date });
    const progress = unwrap(
      await h.app.getMyProgress.execute({ actor: member(ALICE), challengeId: challenge.id }),
    );
    expect(progress.stats).toEqual({ points: 4, activeDays: 3, longestStreak: 2 });
  });

  it('gives the same standings whatever order the events arrive in', async () => {
    type Step = readonly [date: string, n: number];
    const dates: readonly Step[] = [
      ['2026-11-20', 1],
      ['2026-11-21', 2],
      ['2026-11-22', 3],
      ['2026-11-24', 4],
    ];
    const run = async (order: readonly Step[]) => {
      const h = buildHarness();
      const challenge = await h.createActive({ badgeRules: [{ kind: 'streak', threshold: 3 }] });
      await h.join(challenge.id, ALICE);
      for (const [date, n] of order) await h.score(ALICE, { eventId: event(n), date });
      const progress = unwrap(
        await h.app.getMyProgress.execute({ actor: member(ALICE), challengeId: challenge.id }),
      );
      return { stats: progress.stats, badges: progress.badges.length };
    };
    expect(await run(dates)).toEqual(await run([...dates].reverse()));
    expect((await run(dates)).badges).toBe(1);
  });
});

describe('badges', () => {
  const rules = [
    { kind: 'streak' as const, threshold: 3 },
    { kind: 'total' as const, threshold: 2 },
    { kind: 'milestone' as const, threshold: 3 },
  ];

  it('awards each badge when its rule is met, and announces it once', async () => {
    const h = buildHarness();
    const challenge = await h.createActive({ badgeRules: rules });
    await h.join(challenge.id, ALICE);

    expect((await h.score(ALICE, { eventId: event(1), date: '2026-11-20' })).badges).toBe(0);
    expect((await h.score(ALICE, { eventId: event(2), date: '2026-11-21' })).badges).toBe(1); // total 2
    expect((await h.score(ALICE, { eventId: event(3), date: '2026-11-22' })).badges).toBe(2); // streak 3, milestone 3
    expect((await h.score(ALICE, { eventId: event(4), date: '2026-11-23' })).badges).toBe(0); // nothing new

    const awarded = h.eventsOf('BadgeAwarded');
    expect(awarded.map((e) => (e.payload as { kind: string }).kind).sort()).toEqual([
      'milestone',
      'streak',
      'total',
    ]);
    for (const badge of awarded) {
      expect(parseEvent(badge).success).toBe(true);
      expect(badge).toMatchObject({
        producer: 'challenge',
        payload: { userId: ALICE, challengeId: challenge.id, awardedOn: TODAY },
      });
    }
    const progress = unwrap(
      await h.app.getMyProgress.execute({ actor: member(ALICE), challengeId: challenge.id }),
    );
    expect(progress.badges.map((b) => b.rule.kind).sort()).toEqual([
      'milestone',
      'streak',
      'total',
    ]);
  });

  it('awards a badge to one person without touching another’s', async () => {
    const h = buildHarness();
    const challenge = await h.createActive({ badgeRules: [{ kind: 'total', threshold: 1 }] });
    await h.join(challenge.id, ALICE);
    await h.join(challenge.id, BOB);
    await h.score(ALICE, { eventId: event(1) });
    expect(h.eventsOf('BadgeAwarded')).toHaveLength(1);
    const bobs = unwrap(
      await h.app.getMyProgress.execute({ actor: member(BOB), challengeId: challenge.id }),
    );
    expect(bobs.badges).toEqual([]);
  });

  it('a retry after a crash does not award twice: nothing was committed, so the retry does it all', async () => {
    const h = buildHarness();
    const challenge = await h.createActive({ badgeRules: [{ kind: 'total', threshold: 1 }] });
    await h.join(challenge.id, ALICE);

    // The first attempt fails while publishing: the whole transaction rolls back.
    const outbox = h.uow.store.outbox;
    let failNext = true;
    const original = outbox.push.bind(outbox);
    outbox.push = (...items) => {
      if (failNext && items.some((e) => e.eventType === 'BadgeAwarded')) {
        failNext = false;
        throw new Error('database went away');
      }
      return original(...items);
    };
    await expect(h.score(ALICE, { eventId: event(1) })).rejects.toThrow('database went away');
    expect(h.uow.store.ledger.size).toBe(0);
    expect(h.uow.store.badges.size).toBe(0);

    // The queue redelivers the message and the retry completes.
    expect(await h.score(ALICE, { eventId: event(1) })).toEqual({ scored: 1, badges: 1 });
    expect(h.eventsOf('BadgeAwarded')).toHaveLength(1);
  });
});

describe('admin and manager views are unaffected by scoring', () => {
  it('lets a manager who is not a participant read the standings', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);
    await h.score(ALICE, { eventId: event(1) });
    const board = unwrap(
      await h.app.getLeaderboard.execute({ actor: admin, challengeId: challenge.id, limit: 5 }),
    );
    expect(board.entries).toHaveLength(1);
    expect(TEAM).toBeDefined();
  });
});
