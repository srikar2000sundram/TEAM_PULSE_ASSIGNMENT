import type { Principal } from '@teampulse/auth';
import type { EventPayload } from '@teampulse/contracts';
import { err, ok, validationError, type Result } from '@teampulse/kernel';
import type { Habit, Sharing, Viewer } from '../domain/habit.js';

/** A Principal already has the right shape; this makes the intent explicit at call sites. */
export const viewerOf = (principal: Principal): Viewer => ({
  userId: principal.userId,
  teamIds: principal.teamIds,
});

/**
 * Builds a Sharing from request fields. The contract schemas already reject inconsistent input;
 * this keeps the application layer from trusting that.
 */
export function sharingFrom(
  visibility: 'private' | 'team',
  teamId: string | undefined,
): Result<Sharing> {
  if (visibility === 'team' && teamId !== undefined) return ok({ visibility, teamId });
  if (visibility === 'private' && teamId === undefined) return ok({ visibility });
  return err(
    validationError(
      'habit.sharing_invalid',
      'A team is required for team habits and not allowed for private habits',
    ),
  );
}

/** For updates: both absent means "no change"; a team without a visibility is ambiguous. */
export function sharingChangeFrom(
  visibility: 'private' | 'team' | undefined,
  teamId: string | undefined,
): Result<Sharing | undefined> {
  if (visibility === undefined && teamId === undefined) return ok(undefined);
  if (visibility === undefined) {
    return err(
      validationError('habit.sharing_invalid', 'A team can only be given with a visibility'),
    );
  }
  return sharingFrom(visibility, teamId);
}

/**
 * What other services learn about a habit. Identifiers, the activity type and the reminder only:
 * never the title or description (ADR-0005).
 */
export function habitSnapshot(habit: Habit): EventPayload<'HabitCreated'> {
  return {
    habitId: habit.id,
    ownerUserId: habit.ownerUserId,
    visibility: habit.visibility,
    activityType: habit.activityType,
    ...(habit.reminder === null ? {} : { reminder: habit.reminder }),
  };
}
