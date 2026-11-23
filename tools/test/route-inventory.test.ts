import { describe, expect, it } from 'vitest';
import type { Route } from '../../packages/http/src/index.js';
import { buildChallengeRoutes } from '../../services/challenge/src/adapters/http/routes.js';
import { buildEventTrackingRoutes } from '../../services/event-tracking/src/adapters/http/routes.js';
import { buildHabitRoutes } from '../../services/habit/src/adapters/http/routes.js';
import { buildIdentityRoutes } from '../../services/identity/src/adapters/http/routes.js';
import { buildInsightRoutes } from '../../services/insight/src/adapters/http/routes.js';
import { buildNotificationRoutes } from '../../services/notification/src/adapters/http/routes.js';
import { buildRecommendationRoutes } from '../../services/recommendation/src/adapters/http/routes.js';

/*
 * The security surface of the platform, written down and checked: which routes can be called without
 * signing in, and which state-changing routes have no rate limit. A new route that is public by
 * accident, or an unlimited write, fails here and has to be decided on purpose.
 */

const useCases = {} as never;
const services: Record<string, Route[]> = {
  identity: buildIdentityRoutes({
    useCases,
    jwks: () => ({ keys: [] }),
    cookie: { name: 'refresh', path: '/', secure: true },
  }),
  habit: buildHabitRoutes({ useCases }),
  'event-tracking': buildEventTrackingRoutes({ useCases }),
  challenge: buildChallengeRoutes({ useCases }),
  insight: buildInsightRoutes({ useCases }),
  notification: buildNotificationRoutes({ useCases }),
  recommendation: buildRecommendationRoutes({ useCases }),
};

const all = Object.entries(services).flatMap(([service, routes]) =>
  routes.map((route) => ({ service, route, id: `${service} ${route.method} ${route.path}` })),
);

/** The only routes that may be called without an access token, and why. */
const PUBLIC = [
  'identity POST /auth/login', // how a person signs in
  'identity POST /auth/refresh', // uses the httpOnly refresh cookie instead of an access token
  'identity POST /auth/logout', // revokes the refresh cookie's token
  'identity GET /.well-known/jwks.json', // public keys so other services can verify tokens
];

/**
 * State-changing routes that have no rate limit of their own, with the reason it is acceptable.
 * Each is an administrator action or a cheap, idempotent change by a signed-in person; none can be
 * used to guess a secret. Shrink this list rather than grow it.
 */
const UNLIMITED_WRITES: string[] = [];

describe('route inventory', () => {
  it('has routes for every service', () => {
    for (const [service, routes] of Object.entries(services)) {
      expect(routes.length, service).toBeGreaterThan(0);
    }
  });

  it('allows exactly the known routes to be called without signing in', () => {
    const open = all.filter(({ route }) => route.auth === 'public').map(({ id }) => id);
    expect(open.sort()).toEqual([...PUBLIC].sort());
  });

  it('requires a token on everything else', () => {
    for (const { id, route } of all) {
      if (!PUBLIC.includes(id)) expect(route.auth, id).toBe('required');
    }
  });

  it('rate limits every public route that changes state', () => {
    for (const { id, route } of all) {
      if (route.auth === 'public' && route.method !== 'GET') {
        expect(route.rateLimit, `${id} is public and writes, so it needs a limit`).toBeDefined();
      }
    }
  });

  it('rate limits the state-changing routes, apart from the listed exceptions', () => {
    const unlimited = all
      .filter(({ route }) => route.method !== 'GET' && route.rateLimit === undefined)
      .map(({ id }) => id)
      .sort();
    expect(unlimited).toEqual([...UNLIMITED_WRITES].sort());
  });

  it('keeps every limit within a sane range', () => {
    for (const { id, route } of all) {
      if (route.rateLimit === undefined) continue;
      expect(route.rateLimit.timeWindowMs, id).toBe(60_000);
      expect(route.rateLimit.max, id).toBeGreaterThan(0);
      expect(route.rateLimit.max, id).toBeLessThanOrEqual(120);
    }
  });

  it('limits sign-in and password changes strictly, because they can be used to guess secrets', () => {
    const limit = (id: string) => all.find((entry) => entry.id === id)?.route.rateLimit?.max;
    expect(limit('identity POST /auth/login')).toBeLessThanOrEqual(10);
    expect(limit('identity POST /me/password')).toBeLessThanOrEqual(10);
  });
});
