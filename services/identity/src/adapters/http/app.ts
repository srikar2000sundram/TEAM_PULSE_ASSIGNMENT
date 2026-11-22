import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { createLocalJwksVerifier } from '@teampulse/auth/jwt';
import { isTransientDatabaseError } from '@teampulse/db';
import { createServer, registerRoutes, type ServerOptions } from '@teampulse/http';
import { unavailableError, type Clock } from '@teampulse/kernel';
import type { IdentityUseCases } from '../../application/index.js';
import type { KeyRing } from '../security/jwt-access-token-issuer.js';
import { buildIdentityRoutes, type CookieOptions } from './routes.js';

export const BASE_PATH = '/api/v1/identity';

export interface IdentityAppOptions extends Pick<
  ServerOptions,
  'logger' | 'corsOrigins' | 'trustProxy' | 'readiness' | 'idGenerator'
> {
  readonly useCases: IdentityUseCases;
  readonly keyRing: KeyRing;
  readonly clock: Clock;
  readonly issuer: string;
  readonly audience: string;
  readonly cookieSecure: boolean;
  /** Requests per minute per client for everything not covered by a stricter per-route limit. */
  readonly defaultRateLimitPerMinute?: number;
}

/** Assembles the Fastify application: shared plumbing, cookies, rate limits and the routes. */
export async function buildIdentityApp(options: IdentityAppOptions): Promise<FastifyInstance> {
  const app = await createServer({
    serviceName: 'identity-service',
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

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: options.defaultRateLimitPerMinute ?? 300,
    timeWindow: '1 minute',
    // Probes come from the load balancer every few seconds and must never be throttled.
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
  });

  const cookieOptions: CookieOptions = {
    name: 'tp_refresh',
    path: `${BASE_PATH}/auth`,
    secure: options.cookieSecure,
  };

  registerRoutes(
    app,
    buildIdentityRoutes({
      useCases: options.useCases,
      jwks: () => options.keyRing.jwks(),
      cookie: cookieOptions,
    }),
    {
      // The service verifies its own tokens locally, exactly as every other service verifies them
      // through the JWKS endpoint.
      verifier: createLocalJwksVerifier(options.keyRing.jwks(), {
        issuer: options.issuer,
        audience: options.audience,
        clock: options.clock,
      }),
      basePath: BASE_PATH,
      openApi: { title: 'TeamPulse Identity API', version: '1.0.0' },
    },
  );

  return app;
}
