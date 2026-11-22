import { buildOpenApiDocument } from '@teampulse/http';
import { BASE_PATH } from '../adapters/http/app.js';
import { buildHabitRoutes } from '../adapters/http/routes.js';
import type { HabitUseCases } from '../application/index.js';

/**
 * The OpenAPI document for the Habit API, built from the real route definitions.
 * Describing the API needs only the routes' schemas, never the use cases, so none are supplied.
 */
export function habitOpenApiDocument(): Record<string, unknown> {
  const routes = buildHabitRoutes({ useCases: {} as HabitUseCases });
  return buildOpenApiDocument(
    {
      title: 'TeamPulse Habit API',
      version: '1.0.0',
      description:
        'Habits, private versus team visibility, and reminders. Errors use RFC 9457 problem details.',
    },
    routes,
    BASE_PATH,
  );
}
