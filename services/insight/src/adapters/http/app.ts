import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { AccessTokenVerifier } from '@teampulse/auth';
import { createServer, registerRoutes, type ServerOptions } from '@teampulse/http';
import { unavailableError } from '@teampulse/kernel';
import type { InsightUseCases } from '../../application/index.js';
import { buildInsightRoutes } from './routes.js';

export const BASE_PATH = '/api/v1/insight';

export interface InsightAppOptions extends Pick<
  ServerOptions,
  'logger' | 'corsOrigins' | 'trustProxy' | 'readiness' | 'idGenerator'
> {
  readonly useCases: InsightUseCases;
  /** Verifies Identity-issued access tokens (remote JWKS in production). */
  readonly verifier: AccessTokenVerifier;
  /** Requests per minute per client for everything not covered by a stricter per-route limit. */
  readonly defaultRateLimitPerMinute?: number;
}

/**
 * Errors that mean "DynamoDB is not available right now" (throttling, timeouts, a missing role).
 * They are the caller's cue to retry shortly (503), not a bug in our code (500).
 */
export function isTransientStoreError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'RequestLimitExceeded',
    'InternalServerError',
    'ServiceUnavailable',
    'TimeoutError',
    'TransactionCanceledException',
    'TransactionConflictException',
  ].includes(error.name);
}

/** Assembles the Fastify application: shared plumbing, rate limits and the routes. */
export async function buildInsightApp(options: InsightAppOptions): Promise<FastifyInstance> {
  const app = await createServer({
    serviceName: 'insight-service',
    ...options,
    classifyError: (error) =>
      isTransientStoreError(error)
        ? unavailableError(
            'service.unavailable',
            'The service is temporarily unavailable, try again shortly',
          )
        : undefined,
  });

  await app.register(rateLimit, {
    global: true,
    max: options.defaultRateLimitPerMinute ?? 300,
    timeWindow: '1 minute',
    // Probes come from the load balancer every few seconds and must never be throttled.
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
  });

  registerRoutes(app, buildInsightRoutes({ useCases: options.useCases }), {
    verifier: options.verifier,
    basePath: BASE_PATH,
    openApi: { title: 'TeamPulse Insight API', version: '1.0.0' },
  });

  return app;
}
