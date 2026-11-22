import { buildOpenApiDocument } from '@teampulse/http';
import { BASE_PATH } from '../adapters/http/app.js';
import { buildIdentityRoutes } from '../adapters/http/routes.js';
import type { IdentityUseCases } from '../application/index.js';

/**
 * The OpenAPI document for the Identity API, built from the real route definitions.
 * Describing the API needs only the routes' schemas, never the use cases, so none are supplied.
 */
export function identityOpenApiDocument(): Record<string, unknown> {
  const routes = buildIdentityRoutes({
    useCases: {} as IdentityUseCases,
    jwks: () => ({ keys: [] }),
    cookie: { name: 'tp_refresh', path: `${BASE_PATH}/auth`, secure: true },
  });
  return buildOpenApiDocument(
    {
      title: 'TeamPulse Identity API',
      version: '1.0.0',
      description:
        'Sign-in, sessions, users, teams and memberships. Errors use RFC 9457 problem details.',
    },
    routes,
    BASE_PATH,
  );
}
