import { buildOpenApiDocument } from '@teampulse/http';
import { BASE_PATH } from '../adapters/http/app.js';
import { buildChallengeRoutes } from '../adapters/http/routes.js';
import type { ChallengeUseCases } from '../application/index.js';

/**
 * The OpenAPI document for the Challenge API, built from the real route definitions.
 * Describing the API needs only the routes' schemas, never the use cases, so none are supplied.
 */
export function challengeOpenApiDocument(): Record<string, unknown> {
  const routes = buildChallengeRoutes({ useCases: {} as ChallengeUseCases });
  return buildOpenApiDocument(
    {
      title: 'TeamPulse Challenge API',
      version: '1.0.0',
      description:
        'Team challenges, participation, leaderboards and badges. Errors use RFC 9457 problem details.',
    },
    routes,
    BASE_PATH,
  );
}
