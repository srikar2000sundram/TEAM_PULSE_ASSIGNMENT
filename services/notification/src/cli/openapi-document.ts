import { buildOpenApiDocument } from '@teampulse/http';
import { BASE_PATH } from '../adapters/http/app.js';
import { buildNotificationRoutes } from '../adapters/http/routes.js';
import type { NotificationUseCases } from '../application/index.js';

/**
 * The OpenAPI document for the Notification API, built from the real route definitions.
 * Describing the API needs only the routes' schemas, never the use cases, so none are supplied.
 */
export function notificationOpenApiDocument(): Record<string, unknown> {
  const routes = buildNotificationRoutes({ useCases: {} as NotificationUseCases });
  return buildOpenApiDocument(
    {
      title: 'TeamPulse Notification API',
      version: '1.0.0',
      description:
        'In-app notifications and notification preferences. Errors use RFC 9457 problem details.',
    },
    routes,
    BASE_PATH,
  );
}
