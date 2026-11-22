import { conflictError, type AppError } from '@teampulse/kernel';

/**
 * Domain-level conflicts, defined once. Every persistence adapter returns these exact errors, so
 * the in-memory fakes and PostgreSQL cannot drift apart (the repository contract suite checks it).
 */
export const emailTaken = (): AppError =>
  conflictError('user.email_taken', 'That email is already registered');

export const teamNameTaken = (): AppError =>
  conflictError('team.name_taken', 'That team name is already in use');
