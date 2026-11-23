import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AccessTokenVerifier, Principal } from '@teampulse/auth';
import { PROBLEM_CONTENT_TYPE } from '@teampulse/contracts';
import { AppError, UuidGenerator, unauthorizedError, type IdGenerator } from '@teampulse/kernel';
import { CORRELATION_ID_HEADER, runWithCorrelationId, type Logger } from '@teampulse/observability';
import { buildOpenApiDocument, type OpenApiInfo } from './openapi.js';
import {
  STATUS_BY_KIND,
  internalProblem,
  problemFromAppError,
  problemFromStatus,
} from './problem.js';
import type { Route } from './route.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;
const HEALTH_PATHS = new Set(['/healthz', '/readyz']);
const READINESS_TIMEOUT_MS = 2_000;

export interface ServerOptions {
  readonly serviceName: string;
  readonly logger: Logger;
  /** Browser origins allowed to call the API with credentials. Empty disables CORS. */
  readonly corsOrigins?: readonly string[];
  /**
   * Set when running behind exactly one proxy (the ALB in AWS, nginx locally) so the client IP and
   * protocol come from its forwarded headers. Only that one proxy is trusted: the address it appended
   * is used, and anything a client put earlier in `X-Forwarded-For` is ignored, so a client cannot
   * pick its own IP address to dodge a rate limit.
   */
  readonly trustProxy?: boolean;
  readonly bodyLimitBytes?: number;
  /** Named dependency checks for `/readyz`. Each must reject when its dependency is unusable. */
  readonly readiness?: Readonly<Record<string, () => Promise<void>>>;
  readonly idGenerator?: IdGenerator;
  /**
   * Lets a service turn infrastructure errors it understands (for example a database outage) into
   * an `AppError`, so they surface as 503 "try again" instead of an opaque 500. Return
   * `undefined` for errors that are genuinely unexpected.
   */
  readonly classifyError?: (error: unknown) => AppError | undefined;
}

/** Fastify wants a pino-shaped logger; ours has the same call shapes but stricter parameter types. */
const asFastifyLogger = (logger: Logger): FastifyBaseLogger =>
  logger as unknown as FastifyBaseLogger;

function safeStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

const CLIENT_ERROR_DETAIL: Readonly<Record<number, readonly [string, string]>> = {
  400: ['http.bad_request', 'The request is malformed'],
  413: ['http.payload_too_large', 'The request body is too large'],
  415: ['http.unsupported_media_type', 'Content type must be application/json'],
  429: ['rate_limited', 'Too many requests, try again later'],
};

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const ids = options.idGenerator ?? new UuidGenerator();
  const { logger } = options;

  const app = Fastify({
    loggerInstance: asFastifyLogger(logger),
    // We write one structured line per request ourselves, so Fastify never serialises a request
    // object (which could carry headers or tokens) into the log.
    logController: new LogController({ disableRequestLogging: true }),
    // Trust only the directly connected proxy (hop 0); see the option's comment.
    trustProxy: options.trustProxy === true ? (_address: string, hop: number) => hop < 1 : false,
    bodyLimit: options.bodyLimitBytes ?? 100 * 1024,
    // The request id IS the correlation id: honour a valid incoming UUID, otherwise create one.
    genReqId: (request) => {
      const incoming = request.headers[CORRELATION_ID_HEADER];
      return typeof incoming === 'string' && UUID.test(incoming) ? incoming : ids.next();
    },
    // Reject ambiguous or oversized parameters early.
    routerOptions: { maxParamLength: 200 },
  });

  // JSON only. Fastify also accepts text/plain by default, but that is exactly the content type a
  // cross-site HTML form can send, so removing it closes a CSRF route against cookie-based
  // endpoints (refresh, logout). Anything but application/json now gets a 415.
  app.removeContentTypeParser('text/plain');

  await app.register(cors, {
    origin:
      options.corsOrigins && options.corsOrigins.length > 0 ? [...options.corsOrigins] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', CORRELATION_ID_HEADER, 'Idempotency-Key'],
    exposedHeaders: [CORRELATION_ID_HEADER],
    maxAge: 600,
  });

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header(CORRELATION_ID_HEADER, request.id);
    runWithCorrelationId(request.id, done);
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    // Defaults for an API that returns JSON only. Routes may override (for example JWKS caching).
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const level = HEALTH_PATHS.has(route) ? 'debug' : 'info';
    // Route pattern, never the raw URL: it avoids logging ids and query strings.
    logger[level](
      {
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(
        problemFromStatus(404, 'route.not_found', 'The requested resource does not exist', {
          correlationId: request.id,
        }),
      );
  });

  app.setErrorHandler((error, request, reply) => {
    const context = { correlationId: request.id };

    const appError = error instanceof AppError ? error : options.classifyError?.(error);
    if (appError !== undefined) {
      const status = STATUS_BY_KIND[appError.kind];
      // Server-side failures keep the original cause in the log; clients only see the safe code.
      if (status >= 500) logger.error({ err: error, code: appError.code }, 'application error');
      else logger.debug({ code: appError.code, status }, 'request rejected');
      if (status === 503) void reply.header('retry-after', '5');
      void reply
        .code(status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problemFromAppError(appError, context));
      return;
    }

    const clientStatus = error instanceof ZodError ? undefined : safeStatus(error);
    if (clientStatus !== undefined) {
      const [code, detail] = CLIENT_ERROR_DETAIL[clientStatus] ?? [
        'http.client_error',
        'The request could not be processed',
      ];
      void reply
        .code(clientStatus)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problemFromStatus(clientStatus, code, detail, context));
      return;
    }

    // Anything else is a bug or an infrastructure failure. Log everything, reveal nothing.
    logger.error({ err: error }, 'unhandled error');
    void reply.code(500).type(PROBLEM_CONTENT_TYPE).send(internalProblem(context));
  });

  app.get('/healthz', () => ({ status: 'ok', service: options.serviceName }));

  app.get('/readyz', async (_request, reply) => {
    const checks = Object.entries(options.readiness ?? {});
    const outcomes = await Promise.all(
      checks.map(async ([name, check]) => {
        try {
          await Promise.race([
            check(),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error('timeout')), READINESS_TIMEOUT_MS).unref(),
            ),
          ]);
          return { name, ok: true };
        } catch (error) {
          logger.warn({ check: name, err: error }, 'readiness check failed');
          return { name, ok: false };
        }
      }),
    );
    const failing = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.name);
    if (failing.length > 0) {
      void reply.code(503);
      return { status: 'unavailable', failing };
    }
    return { status: 'ready' };
  });

  return app;
}

export interface RegisterRoutesOptions {
  /** Required when any route has `auth: 'required'`. */
  readonly verifier?: AccessTokenVerifier;
  /** When provided, serves the generated OpenAPI document at `<basePath>/openapi.json`. */
  readonly openApi?: OpenApiInfo;
  /** Prefix for every route, for example `/api/v1/identity`. */
  readonly basePath?: string;
}

export function registerRoutes(
  app: FastifyInstance,
  routes: readonly Route[],
  options: RegisterRoutesOptions = {},
): void {
  const basePath = options.basePath ?? '';

  // Fail at startup, not on the first request, if a protected route has nothing to verify with.
  if (options.verifier === undefined && routes.some((route) => route.auth === 'required')) {
    throw new Error(
      'registerRoutes: a verifier is required because some routes need authentication',
    );
  }

  const authenticate = async (authorization: string | undefined): Promise<Principal> => {
    const token = authorization === undefined ? undefined : BEARER.exec(authorization)?.[1];
    if (token === undefined || options.verifier === undefined) {
      throw unauthorizedError('auth.missing_token', 'A bearer token is required');
    }
    const result = await options.verifier.verify(token);
    if (!result.ok) throw result.error;
    return result.value;
  };

  for (const route of routes) {
    app.route({
      method: route.method,
      url: `${basePath}${route.path}`,
      // Read by @fastify/rate-limit when the service registers it; ignored otherwise.
      ...(route.rateLimit === undefined
        ? {}
        : {
            config: {
              rateLimit: { max: route.rateLimit.max, timeWindow: route.rateLimit.timeWindowMs },
            },
          }),
      handler: async (request, reply) => {
        const principal =
          route.auth === 'required' ? await authenticate(request.headers.authorization) : undefined;
        await route.execute(request, reply, principal);
        return reply;
      },
    });
  }

  if (options.openApi !== undefined) {
    const document = buildOpenApiDocument(options.openApi, routes, basePath);
    app.get(`${basePath}/openapi.json`, () => document);
  }
}

export interface RunServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly logger: Logger;
  /** Called after the server stops accepting connections, to close pools and so on. */
  readonly onShutdown?: () => Promise<void>;
}

/** Starts listening and shuts down gracefully on SIGTERM and SIGINT (ECS sends SIGTERM first). */
export async function runServer(app: FastifyInstance, options: RunServerOptions): Promise<void> {
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    options.logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await options.onShutdown?.();
      process.exit(0);
    } catch (error) {
      options.logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  await app.listen({ port: options.port, host: options.host ?? '0.0.0.0' });
  options.logger.info({ port: options.port }, 'listening');
}
