import type { Principal } from '@teampulse/auth';
import type { ActivityType, HabitReminder } from '@teampulse/contracts';
import {
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
import { Habit, type HabitChanges } from '../domain/habit.js';
import { habitLimitReached, habitNotFound, habitNotOwned, notTeamMember } from './errors.js';
import type { UnitOfWork } from './ports.js';
import { habitSnapshot, sharingChangeFrom, sharingFrom, viewerOf } from './support.js';

/** Habits are personal and mostly small; a cap keeps one account from growing without bound. */
export const DEFAULT_MAX_ACTIVE_HABITS = 50;

export interface HabitPage {
  readonly items: readonly Habit[];
  readonly nextCursor: string | undefined;
}

export class CreateHabit {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      ids: IdGenerator;
      events: EventFactory;
      logger: Logger;
      maxActiveHabits: number;
    },
  ) {}

  execute(input: {
    actor: Principal;
    title: string;
    description?: string | undefined;
    activityType: ActivityType;
    visibility: 'private' | 'team';
    teamId?: string | undefined;
    reminder?: HabitReminder | undefined;
  }): Promise<Result<Habit>> {
    const sharing = sharingFrom(input.visibility, input.teamId);
    if (!sharing.ok) return Promise.resolve(sharing);

    // Sharing is allowed only with a team the caller really belongs to (taken from their token).
    if (
      sharing.value.visibility === 'team' &&
      !viewerOf(input.actor).teamIds.includes(sharing.value.teamId)
    ) {
      return Promise.resolve(err(notTeamMember()));
    }

    return this.deps.uow.run(async (tx) => {
      // A soft limit: two simultaneous creations could both pass this check, so the cap can be
      // exceeded by a request or two. It is a guard rail against runaway growth, not an invariant.
      if ((await tx.habits.countActiveOwnedBy(input.actor.userId)) >= this.deps.maxActiveHabits) {
        return err(habitLimitReached(this.deps.maxActiveHabits));
      }

      const created = Habit.create({
        id: this.deps.ids.next(),
        ownerUserId: input.actor.userId,
        title: input.title,
        description: input.description,
        activityType: input.activityType,
        sharing: sharing.value,
        reminder: input.reminder,
        now: this.deps.clock.now(),
      });
      if (!created.ok) return created;

      await tx.habits.insert(created.value);
      await tx.outbox.append(this.deps.events.create('HabitCreated', habitSnapshot(created.value)));
      this.deps.logger.info(
        { event: 'habit.created', ownerUserId: input.actor.userId, habitId: created.value.id },
        'habit created',
      );
      return ok(created.value);
    });
  }
}

export class GetHabit {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: { actor: Principal; habitId: string }): Promise<Result<Habit>> {
    return this.deps.uow.run(async (tx) => {
      const habit = await tx.habits.findVisible(input.habitId, viewerOf(input.actor));
      return habit === null ? err(habitNotFound()) : ok(habit);
    });
  }
}

export class ListHabits {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    actor: Principal;
    scope: 'mine' | 'team';
    status: 'active' | 'archived';
    activityType?: ActivityType | undefined;
    teamId?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Result<HabitPage>> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (after !== undefined && !after.ok) return Promise.resolve(after);

    return this.deps.uow.run(async (tx) => {
      const rows = await tx.habits.list({
        viewer: viewerOf(input.actor),
        scope: input.scope,
        status: input.status,
        ...(input.activityType === undefined ? {} : { activityType: input.activityType }),
        ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        // One extra row tells us whether another page exists without a count query.
        limit: input.limit + 1,
        ...(after === undefined ? {} : { after: after.value }),
      });
      return ok(pageOf(rows, input.limit));
    });
  }
}

export interface UpdateHabitInput {
  readonly actor: Principal;
  readonly habitId: string;
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly activityType?: ActivityType | undefined;
  readonly visibility?: 'private' | 'team' | undefined;
  readonly teamId?: string | undefined;
  readonly reminder?: HabitReminder | null | undefined;
}

export class UpdateHabit {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; events: EventFactory; logger: Logger },
  ) {}

  execute(input: UpdateHabitInput): Promise<Result<Habit>> {
    const change = sharingChangeFrom(input.visibility, input.teamId);
    if (!change.ok) return Promise.resolve(change);
    const sharing = change.value;
    if (sharing?.visibility === 'team' && !input.actor.teamIds.includes(sharing.teamId)) {
      return Promise.resolve(err(notTeamMember()));
    }

    const changes: HabitChanges = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.activityType === undefined ? {} : { activityType: input.activityType }),
      ...(sharing === undefined ? {} : { sharing }),
      ...(input.reminder === undefined ? {} : { reminder: input.reminder }),
    };

    return this.deps.uow.run(async (tx) => {
      // Locked, so two simultaneous edits of one habit apply one after the other.
      const habit = await tx.habits.findVisible(input.habitId, viewerOf(input.actor), {
        lock: true,
      });
      if (habit === null) return err(habitNotFound());
      // Visible but not theirs (a teammate's shared habit): 403. Hidden habits already got 404.
      if (!habit.isOwnedBy(input.actor.userId)) return err(habitNotOwned());

      const updated = habit.apply(changes, this.deps.clock.now());
      if (!updated.ok) return updated;

      await tx.habits.update(updated.value);
      // Title and description are private to this service; only changes other services can see
      // (sharing, activity type, reminder) are published.
      if (habit.differsForSubscribers(updated.value)) {
        await tx.outbox.append(
          this.deps.events.create('HabitUpdated', habitSnapshot(updated.value)),
        );
      }
      this.deps.logger.info(
        { event: 'habit.updated', ownerUserId: input.actor.userId, habitId: habit.id },
        'habit updated',
      );
      return ok(updated.value);
    });
  }
}

export class ArchiveHabit {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; events: EventFactory; logger: Logger },
  ) {}

  execute(input: { actor: Principal; habitId: string }): Promise<Result<Habit>> {
    return this.deps.uow.run(async (tx) => {
      const habit = await tx.habits.findVisible(input.habitId, viewerOf(input.actor), {
        lock: true,
      });
      if (habit === null) return err(habitNotFound());
      if (!habit.isOwnedBy(input.actor.userId)) return err(habitNotOwned());

      // Idempotent: archiving again succeeds quietly and publishes nothing.
      if (habit.isArchived) return ok(habit);

      const archived = habit.archive(this.deps.clock.now());
      await tx.habits.update(archived);
      await tx.outbox.append(
        this.deps.events.create('HabitArchived', {
          habitId: archived.id,
          ownerUserId: archived.ownerUserId,
        }),
      );
      this.deps.logger.info(
        { event: 'habit.archived', ownerUserId: input.actor.userId, habitId: habit.id },
        'habit archived',
      );
      return ok(archived);
    });
  }
}
