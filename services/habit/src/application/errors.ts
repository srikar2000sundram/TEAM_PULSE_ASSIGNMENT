import { conflictError, forbiddenError, notFoundError, type AppError } from '@teampulse/kernel';

/**
 * Also the answer for a habit the caller may not see: "does not exist" and "exists but is hidden"
 * must be indistinguishable, or the error itself would reveal other people's habits.
 */
export const habitNotFound = (): AppError => notFoundError('habit.not_found', 'Habit not found');

/** The caller can see the habit (it is shared with them) but it is not theirs to change. */
export const habitNotOwned = (): AppError =>
  forbiddenError('habit.not_owner', 'Only the owner can change this habit');

export const notTeamMember = (): AppError =>
  forbiddenError('habit.team_not_member', 'You can only share habits with teams you belong to');

export const habitLimitReached = (limit: number): AppError =>
  conflictError(
    'habit.limit_reached',
    `You can have at most ${limit} active habits, archive one first`,
  );
