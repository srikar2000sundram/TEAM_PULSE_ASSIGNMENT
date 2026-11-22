import { describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import { ALICE, TEAM, buildHarness, manager, member, uuid } from '../support/harness.js';

describe('AdvanceChallenges', () => {
  it('starts a draft on its start date, and not before', async () => {
    const h = buildHarness();
    const { challenge } = await h.create({ startsOn: '2026-11-25', endsOn: '2026-11-30' });

    expect(unwrap(await h.app.advanceChallenges.execute())).toEqual({ started: 0, completed: 0 });
    h.clock.set('2026-11-25T00:00:01Z');
    expect(unwrap(await h.app.advanceChallenges.execute())).toEqual({ started: 1, completed: 0 });
    expect(
      unwrap(await h.app.getChallenge.execute({ actor: member(ALICE), challengeId: challenge.id }))
        .challenge.status,
    ).toBe('active');
  });

  it('leaves a draft alone once its end date has passed', async () => {
    const h = buildHarness();
    const { challenge } = await h.create({ startsOn: '2026-11-20', endsOn: '2026-11-21' });
    h.clock.set('2026-11-25T08:00:00Z');
    expect(unwrap(await h.app.advanceChallenges.execute())).toEqual({ started: 0, completed: 0 });
    expect(h.uow.store.challenges.get(challenge.id)?.status).toBe('draft');
  });

  it('completes a challenge only after its last day and the grace period, and announces it once', async () => {
    const h = buildHarness({ graceDays: 1 });
    const challenge = await h.createActive({ startsOn: '2026-11-20', endsOn: '2026-11-22' });
    await h.join(challenge.id, ALICE);

    for (const moment of ['2026-11-22T23:59:00Z', '2026-11-23T12:00:00Z']) {
      h.clock.set(moment); // still inside the last day or the grace day
      expect(unwrap(await h.app.advanceChallenges.execute()).completed, moment).toBe(0);
    }
    h.clock.set('2026-11-24T00:00:30Z');
    expect(unwrap(await h.app.advanceChallenges.execute()).completed).toBe(1);

    const done = h.uow.store.challenges.get(challenge.id);
    expect(done).toMatchObject({ status: 'completed', completedOn: '2026-11-22' });
    const completed = h.eventsOf('ChallengeCompleted');
    expect(completed).toHaveLength(1);
    expect(parseEvent(completed[0]).success).toBe(true);
    expect(completed[0]).toMatchObject({
      producer: 'challenge',
      payload: { challengeId: challenge.id, completedOn: '2026-11-22' },
    });

    // The next ticks (and the other instances' ticks) find nothing more to do.
    expect(unwrap(await h.app.advanceChallenges.execute())).toEqual({ started: 0, completed: 0 });
    expect(h.eventsOf('ChallengeCompleted')).toHaveLength(1);
  });

  it('still counts a last-day activity that arrives during the grace period, and none after completion', async () => {
    const h = buildHarness({ graceDays: 1 });
    const challenge = await h.createActive({ startsOn: '2026-11-20', endsOn: '2026-11-22' });
    await h.join(challenge.id, ALICE);

    h.clock.set('2026-11-23T05:00:00Z'); // someone in the Americas, still on the 22nd
    expect(unwrap(await h.app.advanceChallenges.execute()).completed).toBe(0);
    expect(await h.score(ALICE, { eventId: uuid(1), date: '2026-11-22' })).toEqual({
      scored: 1,
      badges: 0,
    });

    h.clock.set('2026-11-24T00:10:00Z');
    expect(unwrap(await h.app.advanceChallenges.execute()).completed).toBe(1);
    expect(await h.score(ALICE, { eventId: uuid(2), date: '2026-11-22' })).toEqual({
      scored: 0,
      badges: 0,
    });
  });

  it('keeps the final standings readable after completion', async () => {
    const h = buildHarness({ graceDays: 0 });
    const challenge = await h.createActive({ startsOn: '2026-11-20', endsOn: '2026-11-20' });
    await h.join(challenge.id, ALICE);
    await h.score(ALICE, { eventId: uuid(1) });
    h.clock.set('2026-11-21T00:00:10Z');
    await h.app.advanceChallenges.execute();
    const board = unwrap(
      await h.app.getLeaderboard.execute({
        actor: member(ALICE),
        challengeId: challenge.id,
        limit: 5,
      }),
    );
    expect(board).toMatchObject({
      status: 'completed',
      entries: [{ userId: ALICE, points: 1, rank: 1 }],
    });
  });

  it('does not complete a cancelled or draft challenge', async () => {
    const h = buildHarness({ graceDays: 0 });
    const cancelled = await h.createActive({ startsOn: '2026-11-20', endsOn: '2026-11-20' });
    unwrap(await h.app.cancelChallenge.execute({ actor: manager, challengeId: cancelled.id }));
    await h.create({ startsOn: '2026-11-20', endsOn: '2026-11-20' });
    h.clock.set('2026-11-25T00:00:00Z');
    expect(unwrap(await h.app.advanceChallenges.execute())).toEqual({ started: 0, completed: 0 });
    expect(h.eventsOf('ChallengeCompleted')).toEqual([]);
  });

  it('two instances ticking at once publish the completion only once (conditional update)', async () => {
    const h = buildHarness({ graceDays: 0 });
    await h.createActive({ startsOn: '2026-11-20', endsOn: '2026-11-20' });
    h.clock.set('2026-11-21T00:00:10Z');
    const [a, b] = await Promise.all([
      h.app.advanceChallenges.execute(),
      h.app.advanceChallenges.execute(),
    ]);
    expect(unwrap(a).completed + unwrap(b).completed).toBe(1);
    expect(h.eventsOf('ChallengeCompleted')).toHaveLength(1);
  });

  it('handles several challenges in one tick', async () => {
    const h = buildHarness({ graceDays: 0 });
    for (const name of ['A', 'B', 'C'])
      await h.createActive({ name, startsOn: '2026-11-20', endsOn: '2026-11-20' });
    await h.create({ name: 'Later', startsOn: '2026-11-22', endsOn: '2026-11-25' });
    h.clock.set('2026-11-22T00:00:10Z');
    expect(unwrap(await h.app.advanceChallenges.execute())).toEqual({ started: 1, completed: 3 });
    expect(TEAM).toBeDefined();
  });
});
