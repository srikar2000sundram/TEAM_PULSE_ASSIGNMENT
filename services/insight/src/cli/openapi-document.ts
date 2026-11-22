import { buildOpenApiDocument } from '@teampulse/http';
import { BASE_PATH } from '../adapters/http/app.js';
import { buildInsightRoutes } from '../adapters/http/routes.js';
import type { InsightUseCases } from '../application/index.js';

/**
 * The OpenAPI document for the Insight API, built from the real route definitions.
 * Describing the API needs only the routes' schemas, never the use cases, so none are supplied.
 */
export function insightOpenApiDocument(): Record<string, unknown> {
  const routes = buildInsightRoutes({ useCases: {} as InsightUseCases });
  return buildOpenApiDocument(
    {
      title: 'TeamPulse Insight API',
      version: '1.0.0',
      description:
        'Team, organisation and personal activity analytics. Numbers about groups are withheld when too few people stand behind them. Errors use RFC 9457 problem details.',
    },
    routes,
    BASE_PATH,
  );
}
