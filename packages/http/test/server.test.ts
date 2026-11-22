import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AccessTokenVerifier, Principal } from '@teampulse/auth';
import {
  type AppError,
  SequentialIdGenerator,
  unavailableError,
  conflictError,
  err,
  forbiddenError,
  notFoundError,
  ok,
  unauthorizedError,
} from '@teampulse/kernel';
import { createLogger, getCorrelationId } from '@teampulse/observability';
import { createServer, defineRoute, registerRoutes, type Route } from '../src/index.js';

const USER = '00000000-0000-4000-8000-0000000000aa';
const CORRELATION = '11111111-1111-4111-8111-111111111111';

const principal: Principal = { userId: USER, role: 'manager', teamIds: [], managedTeamIds: [] };

const verifier: AccessTokenVerifier = {
  verify: (token) =>
    Promise.resolve(
      token === 'good-token' ? ok(principal) : err(unauthorizedError('auth.invalid_token', 'bad')),
    ),
};

const itemSchema = z.strictObject({ id: z.string(), name: z.string() });

function routes(): Route[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/items',
      summary: 'Create an item',
      tags: ['items'],
      auth: 'required',
      body: z.strictObject({ name: z.string().min(2) }),
      success: { status: 201, schema: itemSchema },
      handler: ({ body, principal: caller }) =>
        Promise.resolve(ok({ id: caller.userId, name: body.name })),
    }),
    defineRoute({
      method: 'GET',
      path: '/items/:id',
      summary: 'Get an item',
      auth: 'required',
      params: z.strictObject({ id: z.uuid() }),
      query: z.strictObject({ verbose: z.coerce.boolean().default(false) }),
      success: { status: 200, schema: itemSchema },
      handler: ({ params }) => Promise.resolve(ok({ id: params.id, name: 'x' })),
    }),
    defineRoute({
      method: 'GET',
      path: '/public',
      summary: 'Public',
      auth: 'public',
      success: { status: 200, schema: z.strictObject({ caller: z.string() }) },
      handler: ({ principal: caller }) =>
        Promise.resolve(ok({ caller: caller?.userId ?? 'anonymous' })),
    }),
    defineRoute({
      method: 'DELETE',
      path: '/items/:id',
      summary: 'Delete',
      auth: 'required',
      params: z.strictObject({ id: z.string() }),
      success: { status: 204 },
      handler: ({ params }) => {
        if (params.id === 'missing')
          return Promise.resolve(err(notFoundError('item.not_found', 'No such item')));
        if (params.id === 'busy') return Promise.resolve(err(conflictError('item.busy', 'In use')));
        if (params.id === 'nope') return Promise.resolve(err(forbiddenError()));
        return Promise.resolve(ok(undefined));
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/leaky',
      summary: 'Returns a field the contract does not declare',
      auth: 'public',
      success: { status: 200, schema: itemSchema },
      handler: () =>
        Promise.resolve(ok({ id: '1', name: 'n', passwordHash: 'SECRET-HASH' } as never)),
    }),
    defineRoute({
      method: 'GET',
      path: '/boom',
      summary: 'Throws',
      auth: 'public',
      handler: () => {
        throw new Error('database password is hunter2');
      },
      success: { status: 200 },
    }),
    defineRoute({
      method: 'GET',
      path: '/whoami-log',
      summary: 'Logs inside the handler',
      auth: 'public',
      success: { status: 200, schema: z.strictObject({ correlationId: z.string().optional() }) },
      handler: () => {
        const correlationId = getCorrelationId();
        return Promise.resolve(ok(correlationId === undefined ? {} : { correlationId }));
      },
    }),
  ];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(
  options: {
    readiness?: Record<string, () => Promise<void>>;
    corsOrigins?: string[];
    classifyError?: (error: unknown) => AppError | undefined;
  } = {},
) {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test-service',
    level: 'debug',
    write: (line) => lines.push(line),
    pseudonymSalt: 'salt-salt-salt-salt',
  });
  const app = await createServer({
    serviceName: 'test-service',
    logger,
    idGenerator: new SequentialIdGenerator(),
    ...options,
  });
  registerRoutes(app, routes(), {
    verifier,
    basePath: '/api/v1/test',
    openApi: { title: 'Test API', version: '1.0.0' },
  });
  apps.push(app);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, lines, records };
}

const auth = { authorization: 'Bearer good-token' };

describe('problem+json errors', () => {
  it('maps AppError kinds to status codes and a problem body with the correlation id', async () => {
    const { app } = await setup();
    const cases = [
      ['missing', 404, 'item.not_found'],
      ['busy', 409, 'item.busy'],
      ['nope', 403, 'auth.forbidden'],
    ] as const;
    for (const [id, status, code] of cases) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/test/items/${id}`,
        headers: auth,
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status, code, correlationId: expect.any(String) });
    }
  });

  it('returns a 204 with no body on success without a response schema', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/test/items/ok',
      headers: auth,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('reports every invalid field with its location, and rejects unknown body fields', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test/items',
      headers: auth,
      payload: { name: 'x', isAdmin: true },
    });
    expect(response.statusCode).toBe(400);
    const fields = response.json<{ errors: { field: string }[] }>().errors.map((e) => e.field);
    expect(fields).toContain('body.name');
    expect(fields.some((field) => field.startsWith('body'))).toBe(true);
  });

  it('validates path and query parameters', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/items/not-a-uuid?extra=1',
      headers: auth,
    });
    expect(response.statusCode).toBe(400);
    const fields = response.json<{ errors: { field: string }[] }>().errors.map((e) => e.field);
    expect(fields).toContain('params.id');
  });

  it('answers 415 and 400 for wrong media type and malformed JSON, without parser internals', async () => {
    const { app } = await setup();
    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/v1/test/items',
      headers: { ...auth, 'content-type': 'text/plain' },
      payload: 'name=abc',
    });
    expect(wrongType.statusCode).toBe(415);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/test/items',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toMatch(/JSON|token|position/i);
  });

  it('answers unknown routes with a 404 problem', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'route.not_found' });
  });

  it('hides the cause of an unexpected error but logs it with the same correlation id', async () => {
    const { app, records } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/boom',
      headers: { 'x-correlation-id': CORRELATION },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
    expect(response.json()).toMatchObject({ code: 'internal_error', correlationId: CORRELATION });
    const logged = records().find((record) => record.msg === 'unhandled error');
    expect(logged).toMatchObject({ level: 'error', correlationId: CORRELATION });
    expect(JSON.stringify(logged)).toContain('hunter2');
  });

  it('never lets an undeclared response field leave the service', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/test/leaky' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('SECRET-HASH');
  });
});

describe('error classification', () => {
  it('lets a service turn an infrastructure error into a 503 with Retry-After and no leaked cause', async () => {
    const { app, records } = await setup({
      classifyError: (error) =>
        error instanceof Error && error.message.includes('hunter2')
          ? unavailableError('service.unavailable', 'Try again shortly')
          : undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/test/boom' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.json()).toMatchObject({ code: 'service.unavailable', status: 503 });
    expect(response.body).not.toContain('hunter2');
    // The real cause is still logged for operators.
    expect(JSON.stringify(records().find((r) => r.msg === 'application error'))).toContain(
      'hunter2',
    );
  });

  it('still answers 500 for errors the classifier does not recognise', async () => {
    const { app } = await setup({ classifyError: () => undefined });
    const response = await app.inject({ method: 'GET', url: '/api/v1/test/boom' });
    expect(response.statusCode).toBe(500);
  });
});

describe('authentication', () => {
  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['empty token', 'Bearer '],
    ['spaces in token', 'Bearer a b'],
  ])('rejects %s with a 401', async (_name, header) => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/test/items/${USER}`,
      headers: header === undefined ? {} : { authorization: header },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'auth.missing_token' });
  });

  it('rejects an invalid token with the verifier error', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/test/items/${USER}`,
      headers: { authorization: 'Bearer forged' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'auth.invalid_token' });
  });

  it('passes the verified principal to the handler', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test/items',
      headers: auth,
      payload: { name: 'Run' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: USER, name: 'Run' });
  });

  it('does not require a token on public routes', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/test/public' });
    expect(response.json()).toEqual({ caller: 'anonymous' });
  });

  it('refuses to start routes that need auth when no verifier is supplied', async () => {
    const { app } = await setup();
    expect(() => registerRoutes(app, routes())).toThrow(/verifier is required/);
  });
});

describe('correlation id and logging', () => {
  it('echoes a valid incoming correlation id and exposes it to code inside the handler', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/whoami-log',
      headers: { 'x-correlation-id': CORRELATION },
    });
    expect(response.headers['x-correlation-id']).toBe(CORRELATION);
    expect(response.json()).toEqual({ correlationId: CORRELATION });
  });

  it('replaces an invalid incoming correlation id with a generated one', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/whoami-log',
      headers: { 'x-correlation-id': 'x'.repeat(500) },
    });
    expect(response.headers['x-correlation-id']).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('logs one line per request with the route pattern, not the raw URL or query', async () => {
    const { app, records } = await setup();
    await app.inject({
      method: 'GET',
      url: `/api/v1/test/items/${USER}?verbose=SECRET-QUERY`,
      headers: auth,
    });
    const line = records().find((record) => record.msg === 'request completed');
    expect(line).toMatchObject({
      method: 'GET',
      route: '/api/v1/test/items/:id',
      status: 200,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(records())).not.toContain('SECRET-QUERY');
    expect(JSON.stringify(records())).not.toContain('good-token');
  });
});

describe('health and readiness', () => {
  it('reports liveness', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.json()).toEqual({ status: 'ok', service: 'test-service' });
  });

  it('is ready when every dependency check passes', async () => {
    const { app } = await setup({ readiness: { database: () => Promise.resolve() } });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
  });

  it('is unavailable when a check fails, naming it but never leaking the reason', async () => {
    const { app } = await setup({
      readiness: {
        database: () => Promise.reject(new Error('password authentication failed for user "x"')),
        queue: () => Promise.resolve(),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', failing: ['database'] });
    expect(response.body).not.toContain('password');
  });
});

describe('security headers and CORS', () => {
  it('sets defensive headers and disables caching by default', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/test/public' });
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('allows only configured origins, with credentials', async () => {
    const { app } = await setup({ corsOrigins: ['https://app.teampulse.internal'] });
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/test/public',
      headers: { origin: 'https://app.teampulse.internal' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.teampulse.internal');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/test/public',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('has CORS disabled when no origin is configured', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/public',
      headers: { origin: 'https://app.teampulse.internal' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OpenAPI', () => {
  it('is generated from the route definitions', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/test/openapi.json' });
    const document = response.json<{
      openapi: string;
      paths: Record<string, Record<string, Record<string, unknown>>>;
    }>();
    expect(document.openapi).toBe('3.0.3');

    const create = document.paths['/api/v1/test/items']?.post;
    expect(create?.security).toEqual([{ bearerAuth: [] }]);
    expect(create?.requestBody).toBeDefined();
    expect(create?.responses).toHaveProperty('201');

    const get = document.paths['/api/v1/test/items/{id}']?.get;
    const names = (get?.parameters as { name: string; in: string }[]).map(
      (p) => `${p.in}:${p.name}`,
    );
    expect(names).toEqual(expect.arrayContaining(['path:id', 'query:verbose']));

    expect(document.paths['/api/v1/test/public']?.get?.security).toEqual([]);
  });
});
