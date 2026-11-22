import { describe, expect, it } from 'vitest';
import { createEvent } from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import { buildChallengeEventHandlers } from '../../src/adapters/events/handlers.js';
import {
  ALICE,
  BOB,
  OTHER_TEAM,
  TEAM,
  admin,
  buildHarness,
  manager,
  member,
  uuid,
} from '../support/harness.js';

const at = new Date('2026-11-20T08:00:00Z');

const activity = (n: number, userId = ALICE, date = '2026-11-20') =>
  createEvent('ActivityCompleted', {
    eventId: uuid(0x5000 + n),
    occurredAt: at,
    correlationId: uuid(0x6000 + n),
    payload: {
      userId,
      habitId: uuid(0x51),
      teamIds: [TEAM],
      activityType: 'walking',
      activityDate: date,
      totalCompleted: n,
    },
  });

const membership = (userId: string, teamId: string, change: 'added' | 'removed') =>
  createEvent('TeamMembershipChanged', {
    eventId: uuid(0x7000),
    occurredAt: at,
    correlationId: uuid(0x7001),
    payload: { userId, teamId, change },
  });

const userDeleted = (userId: string) =>
  createEvent('UserDeleted', {
    eventId: uuid(0x8000),
    occurredAt: at,
    correlationId: uuid(0x8001),
    payload: { userId },
  });

describe('Challenge event handlers', () => {
  it('ActivityCompleted scores once, however often it is delivered', async () => {
    const h = buildHarness();
    const handlers = buildChallengeEventHandlers(h.app);
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);

    await handlers.ActivityCompleted?.(activity(1));
    await handlers.ActivityCompleted?.(activity(1));
    await handlers.ActivityCompleted?.(activity(2, ALICE, '2026-11-21'));
    const progress = unwrap(
      await h.app.getMyProgress.execute({ actor: member(ALICE), challengeId: challenge.id }),
    );
    expect(progress.stats).toEqual({ points: 2, activeDays: 2, longestStreak: 2 });
  });

  it('TeamMembershipChanged (removed) takes the person out of the unfinished challenges of that team', async () => {
    const h = buildHarness();
    const handlers = buildChallengeEventHandlers(h.app);
    const mine = await h.createActive({ name: 'Team challenge' });
    await h.join(mine.id, ALICE);
    await h.join(mine.id, BOB);
    await handlers.ActivityCompleted?.(activity(1));
    await handlers.ActivityCompleted?.(activity(2, BOB));

    await handlers.TeamMembershipChanged?.(membership(ALICE, TEAM, 'removed'));
    await handlers.TeamMembershipChanged?.(membership(ALICE, TEAM, 'removed')); // repeated delivery

    const board = unwrap(
      await h.app.getLeaderboard.execute({ actor: admin, challengeId: mine.id, limit: 10 }),
    );
    expect(board.entries.map((e) => e.userId)).toEqual([BOB]);
    expect(h.uow.store.ledger.size).toBe(1); // Alice's points are gone, Bob's stay
  });

  it('only leaves challenges of the team the person left', async () => {
    const h = buildHarness();
    const handlers = buildChallengeEventHandlers(h.app);
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);
    await handlers.TeamMembershipChanged?.(membership(ALICE, OTHER_TEAM, 'removed'));
    expect(h.uow.store.participations.size).toBe(1);
  });

  it('TeamMembershipChanged (added) changes nothing: joining is the person’s own choice', async () => {
    const h = buildHarness();
    const handlers = buildChallengeEventHandlers(h.app);
    const challenge = await h.createActive();
    await handlers.TeamMembershipChanged?.(membership(ALICE, TEAM, 'added'));
    expect(
      unwrap(await h.app.getChallenge.execute({ actor: member(ALICE), challengeId: challenge.id }))
        .joined,
    ).toBe(false);
  });

  it('a finished challenge keeps its final standings when someone leaves the team', async () => {
    const h = buildHarness({ graceDays: 0 });
    const handlers = buildChallengeEventHandlers(h.app);
    const challenge = await h.createActive({ startsOn: '2026-11-20', endsOn: '2026-11-20' });
    await h.join(challenge.id, ALICE);
    await handlers.ActivityCompleted?.(activity(1));
    h.clock.set('2026-11-21T00:00:10Z');
    await h.app.advanceChallenges.execute();

    await handlers.TeamMembershipChanged?.(membership(ALICE, TEAM, 'removed'));
    const board = unwrap(
      await h.app.getLeaderboard.execute({ actor: admin, challengeId: challenge.id, limit: 10 }),
    );
    expect(board.entries).toHaveLength(1);
  });

  it('UserDeleted erases participation, points and badges, and unlinks created challenges', async () => {
    const h = buildHarness();
    const handlers = buildChallengeEventHandlers(h.app);
    const challenge = await h.createActive({ badgeRules: [{ kind: 'total', threshold: 1 }] });
    await h.join(challenge.id, ALICE);
    await h.join(challenge.id, BOB);
    await handlers.ActivityCompleted?.(activity(1));
    await handlers.ActivityCompleted?.(activity(2, BOB));

    await handlers.UserDeleted?.(userDeleted(ALICE));
    await handlers.UserDeleted?.(userDeleted(ALICE)); // repeated delivery

    expect([...h.uow.store.participations.values()].map((p) => p.userId)).toEqual([BOB]);
    expect([...h.uow.store.ledger.values()].map((l) => l.userId)).toEqual([BOB]);
    expect([...h.uow.store.badges.values()].map((b) => b.userId)).toEqual([BOB]);

    await handlers.UserDeleted?.(userDeleted(manager.userId));
    expect(h.uow.store.challenges.get(challenge.id)?.createdByUserId).toBeNull();
  });

  it('lets a failure escape, so the message stays on the queue and is retried', async () => {
    const h = buildHarness();
    const handlers = buildChallengeEventHandlers(h.app);
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);
    const original = h.uow.run.bind(h.uow);
    h.uow.run = () => Promise.reject(new Error('connection lost'));
    await expect(handlers.ActivityCompleted?.(activity(1))).rejects.toThrow('connection lost');
    h.uow.run = original;
    await handlers.ActivityCompleted?.(activity(1));
    expect(h.uow.store.ledger.size).toBe(1);
  });

  it('handles only the events it needs', () => {
    expect(Object.keys(buildChallengeEventHandlers(buildHarness().app)).sort()).toEqual([
      'ActivityCompleted',
      'TeamMembershipChanged',
      'UserDeleted',
    ]);
  });
});
