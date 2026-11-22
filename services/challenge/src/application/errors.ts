import { conflictError, forbiddenError, notFoundError, type AppError } from '@teampulse/kernel';

/**
 * Also the answer for a challenge the caller may not see: "does not exist" and "exists but is not
 * for you" must be indistinguishable, or the error would reveal other teams' challenges.
 */
export const challengeNotFound = (): AppError =>
  notFoundError('challenge.not_found', 'Challenge not found');

/** The caller can see the challenge but only its managers may change it. */
export const notChallengeManager = (): AppError =>
  forbiddenError(
    'challenge.not_manager',
    'Only managers of this team and administrators can do that',
  );

export const teamNotManaged = (): AppError =>
  forbiddenError(
    'challenge.team_not_managed',
    'You can only create challenges for teams you manage',
  );

export const notTeamMember = (): AppError =>
  forbiddenError('challenge.team_not_member', 'Only members of the challenge’s team can join');

export const notParticipant = (): AppError =>
  forbiddenError('challenge.not_participant', 'You are not taking part in this challenge');

export const notJoinable = (): AppError =>
  conflictError('challenge.not_joinable', 'This challenge is not open for joining');
