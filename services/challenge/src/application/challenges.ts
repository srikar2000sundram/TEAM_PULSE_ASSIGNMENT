import type { Principal } from '@teampulse/auth';
import type { ActivityType, ChallengeStatus } from '@teampulse/contracts';
import {
  conflictError,
  decodeCursor,
  err,
  ok,
  pageOf,
  type Clock,
  type IdGenerator,
  type Result,
} from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { EventFactory } from '@teampulse/outbox';
import { Challenge, type BadgeRule } from '../domain/challenge.js';
import { dateOf } from '../domain/dates.js';
import {
  challengeNotFound,
  notChallengeManager,
  notJoinable,
  notTeamMember,
  teamNotManaged,
} from './errors.js';
import type { Transaction, UnitOfWork } from './ports.js';

/** A challenge with what the caller needs to know about it. */
export interface ChallengeView {
  readonly challenge: Challenge;
  readonly participantCount: number;
  /** Whether the caller takes part. */
  readonly joined: boolean;
}

/** Counts participants and "am I in it" for a page of challenges with two queries, not two per row. */
async function describe(
  tx: Transaction,
  challenges: readonly Challenge[],
  userId: string,
): Promise<readonly ChallengeView[]> {
  const ids = challenges.map((challenge) => challenge.id);
  const [counts, joined] = await Promise.all([
    tx.participations.countFor(ids),
    tx.participations.joinedAmong(userId, ids),
  ]);
  return challenges.map((challenge) => ({
    challenge,
    participantCount: counts.get(challenge.id) ?? 0,
    joined: joined.has(challenge.id),
  }));
}

export class CreateChallenge {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator; logger: Logger },
  ) {}

  execute(input: {
    actor: Principal;
    name: string;
    activityType: ActivityType;
    teamId: string;
    startsOn: string;
    endsOn: string;
    badgeRules: readonly { kind: BadgeRule['kind']; threshold: number }[];
  }): Promise<Result<ChallengeView>> {
    const { actor } = input;
    // Administrators may create for any team; a manager only for the teams they manage.
    const allowed =
      actor.role === 'admin' ||
      (actor.role === 'manager' && actor.managedTeamIds.includes(input.teamId));
    if (!allowed) return Promise.resolve(err(teamNotManaged()));

    const created = Challenge.create({
      id: this.deps.ids.next(),
      name: input.name,
      activityType: input.activityType,
      teamId: input.teamId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      badgeRules: input.badgeRules.map((rule) => ({ ...rule, id: this.deps.ids.next() })),
      createdByUserId: actor.userId,
      now: this.deps.clock.now(),
    });
    if (!created.ok) return Promise.resolve(created);

    return this.deps.uow.run(async (tx) => {
      await tx.challenges.insert(created.value);
      this.deps.logger.info(
        { event: 'challenge.created', challengeId: created.value.id },
        'challenge created',
      );
      return ok({ challenge: created.value, participantCount: 0, joined: false });
    });
  }
}

export class GetChallenge {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: { actor: Principal; challengeId: string }): Promise<Result<ChallengeView>> {
    return this.deps.uow.run(async (tx) => {
      const challenge = await tx.challenges.findVisible(input.challengeId, input.actor);
      if (challenge === null) return err(challengeNotFound());
      const [view] = await describe(tx, [challenge], input.actor.userId);
      return view === undefined ? err(challengeNotFound()) : ok(view);
    });
  }
}

export class ListChallenges {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    actor: Principal;
    status?: ChallengeStatus | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Result<{ items: readonly ChallengeView[]; nextCursor: string | undefined }>> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (after !== undefined && !after.ok) return Promise.resolve(after);

    return this.deps.uow.run(async (tx) => {
      const rows = await tx.challenges.list({
        viewer: input.actor,
        ...(input.status === undefined ? {} : { status: input.status }),
        // One extra row tells us whether another page exists without a count query.
        limit: input.limit + 1,
        ...(after === undefined ? {} : { after: after.value }),
      });
      const page = pageOf(rows, input.limit);
      return ok({
        items: await describe(tx, page.items, input.actor.userId),
        nextCursor: page.nextCursor,
      });
    });
  }
}

/** The state changes only managers may make. Shared so start and cancel cannot drift apart. */
abstract class ManagerTransition {
  constructor(
    protected readonly deps: { uow: UnitOfWork; clock: Clock; logger: Logger },
    private readonly event: string,
  ) {}

  protected abstract apply(challenge: Challenge, now: Date): Result<Challenge>;

  execute(input: { actor: Principal; challengeId: string }): Promise<Result<ChallengeView>> {
    return this.deps.uow.run(async (tx) => {
      const challenge = await tx.challenges.findVisible(input.challengeId, input.actor);
      if (challenge === null) return err(challengeNotFound());
      if (!challenge.canBeManagedBy(input.actor)) return err(notChallengeManager());

      const changed = this.apply(challenge, this.deps.clock.now());
      if (!changed.ok) return changed;
      // Another request (or the scheduler) may have moved it since we read it.
      if (!(await tx.challenges.transition(changed.value, challenge.status))) {
        return err(
          conflictError('challenge.invalid_state', 'The challenge was changed by someone else', {
            status: challenge.status,
          }),
        );
      }
      this.deps.logger.info(
        { event: this.event, challengeId: challenge.id },
        `challenge ${changed.value.status}`,
      );
      const [view] = await describe(tx, [changed.value], input.actor.userId);
      return view === undefined ? err(challengeNotFound()) : ok(view);
    });
  }
}

export class StartChallenge extends ManagerTransition {
  constructor(deps: { uow: UnitOfWork; clock: Clock; logger: Logger }) {
    super(deps, 'challenge.started');
  }
  protected apply(challenge: Challenge, now: Date) {
    return challenge.start(now);
  }
}

export class CancelChallenge extends ManagerTransition {
  constructor(deps: { uow: UnitOfWork; clock: Clock; logger: Logger }) {
    super(deps, 'challenge.cancelled');
  }
  protected apply(challenge: Challenge, now: Date) {
    return challenge.cancel(now);
  }
}

/**
 * Joins the signed-in person to a challenge of one of their teams. Joining twice is harmless and
 * announces `ChallengeJoined` only the first time.
 */
export class JoinChallenge {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      events: EventFactory;
      logger: Logger;
    },
  ) {}

  execute(input: { actor: Principal; challengeId: string }): Promise<Result<ChallengeView>> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(async (tx) => {
      const challenge = await tx.challenges.findVisible(input.challengeId, input.actor);
      if (challenge === null) return err(challengeNotFound());
      // A manager outside the team can see the challenge but not take part in it.
      if (!challenge.isMemberTeam(input.actor)) return err(notTeamMember());

      const already = await tx.participations.find(challenge.id, input.actor.userId);
      if (already === null) {
        if (!challenge.canJoinOn(dateOf(now))) return err(notJoinable());
        const added = await tx.participations.add({
          challengeId: challenge.id,
          userId: input.actor.userId,
          teamId: challenge.teamId,
          joinedOn: dateOf(now),
        });
        // A simultaneous request may have joined between our read and our insert: announce once.
        if (added) {
          await tx.outbox.append(
            this.deps.events.create('ChallengeJoined', {
              challengeId: challenge.id,
              userId: input.actor.userId,
              teamId: challenge.teamId,
            }),
          );
        }
        this.deps.logger.info(
          { event: 'challenge.joined', challengeId: challenge.id, userId: input.actor.userId },
          'challenge joined',
        );
      }
      const [view] = await describe(tx, [challenge], input.actor.userId);
      return view === undefined ? err(challengeNotFound()) : ok(view);
    });
  }
}
