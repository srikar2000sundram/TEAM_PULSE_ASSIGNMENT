import type { ProblemDetails } from '@teampulse/contracts';
import { type AppError, type ErrorKind } from '@teampulse/kernel';

/** Transport mapping for the transport-neutral error kinds defined in the kernel. */
export const STATUS_BY_KIND: Readonly<Record<ErrorKind, number>> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
};

const TITLE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

const problemType = (code: string): string => `urn:teampulse:problem:${code}`;

/** Builds the RFC 9457 body for an expected, application-level error. */
export function problemFromAppError(
  error: AppError,
  context: { correlationId?: string | undefined; instance?: string | undefined },
): ProblemDetails {
  const status = STATUS_BY_KIND[error.kind];
  const fieldErrors = error.details.errors;
  return {
    type: problemType(error.code),
    title: TITLE_BY_STATUS[status] ?? 'Error',
    status,
    detail: error.message,
    code: error.code,
    ...(context.instance === undefined ? {} : { instance: context.instance }),
    ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
    ...(Array.isArray(fieldErrors) ? { errors: fieldErrors as FieldError[] } : {}),
  };
}

/** Body for framework-level 4xx errors (bad JSON, wrong media type, rate limit, and so on). */
export function problemFromStatus(
  status: number,
  code: string,
  detail: string,
  context: { correlationId?: string | undefined; instance?: string | undefined },
): ProblemDetails {
  return {
    type: problemType(code),
    title: TITLE_BY_STATUS[status] ?? 'Error',
    status,
    detail,
    code,
    ...(context.instance === undefined ? {} : { instance: context.instance }),
    ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
  };
}

/** Never includes internals: the real error is logged server-side with the same correlation id. */
export function internalProblem(context: {
  correlationId?: string | undefined;
  instance?: string | undefined;
}): ProblemDetails {
  return problemFromStatus(500, 'internal_error', 'An unexpected error occurred', context);
}
