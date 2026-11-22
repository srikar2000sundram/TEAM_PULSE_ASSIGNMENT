import { z } from 'zod';
import type { Route } from './route.js';

type JsonSchema = Record<string, unknown>;

const toSchema = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema =>
  z.toJSONSchema(schema, { target: 'openapi-3.0', io, unrepresentable: 'any' });

/** `/users/:id` becomes `/users/{id}`. */
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function parameters(
  schema: z.ZodType | undefined,
  location: 'path' | 'query',
): Record<string, unknown>[] {
  if (schema === undefined) return [];
  const json = toSchema(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    schema: propertySchema,
  }));
}

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/**
 * Generates the OpenAPI document straight from the route definitions, so the published API
 * description cannot drift from what the service actually validates and returns.
 */
export function buildOpenApiDocument(
  info: OpenApiInfo,
  routes: readonly Route[],
  basePath = '',
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const key = toOpenApiPath(`${basePath}${route.path}`);
    paths[key] ??= {};
    paths[key][route.method.toLowerCase()] = {
      summary: route.summary,
      tags: route.tags,
      security: route.auth === 'required' ? [{ bearerAuth: [] }] : [],
      parameters: [
        ...parameters(route.schemas.params, 'path'),
        ...parameters(route.schemas.query, 'query'),
      ],
      ...(route.schemas.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toSchema(route.schemas.body, 'input') } },
            },
          }),
      responses: {
        [String(route.successStatus)]: {
          description: 'Success',
          ...(route.schemas.response === undefined
            ? {}
            : {
                content: {
                  'application/json': { schema: toSchema(route.schemas.response, 'output') },
                },
              }),
        },
        default: {
          description: 'Error (RFC 9457 problem details)',
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info,
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string' },
            correlationId: { type: 'string' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: { field: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
}
