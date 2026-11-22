/**
 * Application error taxonomy.
 *
 * `kind` is a transport-neutral category. HTTP adapters map it to a status code
 * (validation -> 400, unauthorized -> 401, forbidden -> 403, not_found -> 404, conflict -> 409,
 * rate_limited -> 429, unavailable -> 503); queue consumers map it to retry or dead-letter.
 * The domain and application layers never import HTTP concepts.
 */
export type ErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable';

export type ErrorDetails = Readonly<Record<string, unknown>>;

export class AppError extends Error {
  readonly kind: ErrorKind;
  /** Stable, machine-readable identifier such as `habit.not_found`. Safe to expose to clients. */
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(kind: ErrorKind, code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

export const validationError = (code: string, message: string, details?: ErrorDetails): AppError =>
  new AppError('validation', code, message, details);

export const unauthorizedError = (
  code = 'auth.unauthorized',
  message = 'Authentication is required',
): AppError => new AppError('unauthorized', code, message);

export const forbiddenError = (
  code = 'auth.forbidden',
  message = 'You are not allowed to perform this action',
): AppError => new AppError('forbidden', code, message);

/**
 * Also used instead of `forbiddenError` when revealing that a resource exists would leak
 * information, for example another user's private habit.
 */
export const notFoundError = (code: string, message: string): AppError =>
  new AppError('not_found', code, message);

export const conflictError = (code: string, message: string, details?: ErrorDetails): AppError =>
  new AppError('conflict', code, message, details);

export const rateLimitedError = (
  code = 'rate_limited',
  message = 'Too many requests, try again later',
): AppError => new AppError('rate_limited', code, message);

export const unavailableError = (code: string, message: string): AppError =>
  new AppError('unavailable', code, message);
