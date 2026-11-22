import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { AccessTokenVerifier } from '@teampulse/auth';
import { isTransientDatabaseError } from '@teampulse/db';
import { createServer, registerRoutes, type ServerOptions } from '@teampulse/http';
import { unavailableError } from '@teampulse/kernel';
import type { ChallengeUseCases } from '../../application/index.js';
import { buildChallengeRoutes } from './routes.js';

export const BASE_PATH = '/api/v1/challenge';

export interface ChallengeAppOptions extends Pick<
  ServerOptions,
  'logger' | 'corsOrigins' | 'trustProxy' | 'readiness' | 'idGenerator'
> {
  readonly useCases: ChallengeUseCases;
  /** Verifies Identity-issued access tokens (remote JWKS in production). */
  readonly verifier: AccessTokenVerifier;
  /** Requests per minute per client for everything not covered by a stricter per-route limit. */
  readonly defaultRateLimitPerMinute?: number;
}

/** Assembles the Fastify application: shared plumbing, rate limits and the routes. */
export async function buildChallengeApp(options: ChallengeAppOptions): Promise<FastifyInstance> {
  const app = await createServer({
    serviceName: 'challenge-service',
    ...options,
    // A database outage is the caller's cue to retry shortly (503), not a bug in our code (500).
    classifyError: (error) =>
      isTransientDatabaseError(error)
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

  registerRoutes(app, buildChallengeRoutes({ useCases: options.useCases }), {
    verifier: options.verifier,
    basePath: BASE_PATH,
    openApi: { title: 'TeamPulse Challenge API', version: '1.0.0' },
  });

  return app;
}
