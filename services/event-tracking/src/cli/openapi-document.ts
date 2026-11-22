import { buildOpenApiDocument } from '@teampulse/http';
import { BASE_PATH } from '../adapters/http/app.js';
import { buildEventTrackingRoutes } from '../adapters/http/routes.js';
import type { EventTrackingUseCases } from '../application/index.js';

/**
 * The OpenAPI document for the Event Tracking API, built from the real route definitions.
 * Describing the API needs only the routes' schemas, never the use cases, so none are supplied.
 */
export function eventTrackingOpenApiDocument(): Record<string, unknown> {
  const routes = buildEventTrackingRoutes({ useCases: {} as EventTrackingUseCases });
  return buildOpenApiDocument(
    {
      title: 'TeamPulse Event Tracking API',
      version: '1.0.0',
      description:
        'Records completed habit activities, idempotently. Errors use RFC 9457 problem details.',
    },
    routes,
    BASE_PATH,
  );
}
