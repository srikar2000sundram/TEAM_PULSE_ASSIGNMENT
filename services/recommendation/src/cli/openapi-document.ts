import { buildOpenApiDocument } from '@teampulse/http';
import { BASE_PATH } from '../adapters/http/app.js';
import { buildRecommendationRoutes } from '../adapters/http/routes.js';
import type { RecommendationUseCases } from '../application/index.js';

/**
 * The OpenAPI document for the Recommendation API, built from the real route definitions.
 * Describing the API needs only the routes' schemas, never the use cases, so none are supplied.
 */
export function recommendationOpenApiDocument(): Record<string, unknown> {
  const routes = buildRecommendationRoutes({ useCases: {} as RecommendationUseCases });
  return buildOpenApiDocument(
    {
      title: 'TeamPulse Recommendation API',
      version: '1.0.0',
      description:
        'Personalised timing recommendations built from your own activity history. Errors use RFC 9457 problem details.',
    },
    routes,
    BASE_PATH,
  );
}
