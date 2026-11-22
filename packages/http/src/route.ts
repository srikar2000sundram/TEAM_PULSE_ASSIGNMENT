import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Principal } from '@teampulse/auth';
import { validationError, type Result } from '@teampulse/kernel';
import type { FieldError } from './problem.js';

export interface RateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type AuthMode = 'public' | 'required';

type Schema = z.ZodType;
type Output<S extends Schema | undefined> = S extends Schema ? z.output<S> : undefined;
type PrincipalFor<A extends AuthMode> = A extends 'required' ? Principal : Principal | undefined;

export interface RouteContext<
  P extends Schema | undefined,
  Q extends Schema | undefined,
  B extends Schema | undefined,
  A extends AuthMode,
> {
  /** Validated and typed by the route's schemas. */
  readonly params: Output<P>;
  readonly query: Output<Q>;
  readonly body: Output<B>;
  readonly principal: PrincipalFor<A>;
  /** Escape hatch for adapter concerns such as cookies. Business logic must not use it. */
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

export interface RouteDefinition<
  P extends Schema | undefined,
  Q extends Schema | undefined,
  B extends Schema | undefined,
  R extends Schema | undefined,
  A extends AuthMode,
> {
  readonly method: HttpMethod;
  /** Fastify style path, for example `/users/:id`. */
  readonly path: string;
  readonly summary: string;
  readonly tags?: readonly string[];
  readonly auth: A;
  /** Per-client limit, applied when `@fastify/rate-limit` is registered on the app. */
  readonly rateLimit?: RateLimit;
  readonly params?: P;
  readonly query?: Q;
  readonly body?: B;
  readonly success: { readonly status: number; readonly schema?: R };
  /** Returns a Result: expected failures are values, never thrown. */
  readonly handler: (
    context: RouteContext<P, Q, B, A>,
  ) => Promise<Result<R extends Schema ? z.input<R> : void>>;
}

/**
 * A route with its generics erased. Created by `defineRoute`, which keeps the typed handler in a
 * closure, so lists of routes need neither `any` nor casts at the call site.
 */
export interface Route {
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: AuthMode;
  readonly rateLimit?: RateLimit | undefined;
  readonly schemas: {
    readonly params?: Schema | undefined;
    readonly query?: Schema | undefined;
    readonly body?: Schema | undefined;
    readonly response?: Schema | undefined;
  };
  readonly successStatus: number;
  execute(
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal | undefined,
  ): Promise<void>;
}

function parseWith<S extends Schema | undefined>(
  schema: S,
  value: unknown,
  location: 'params' | 'query' | 'body',
): Output<S> {
  if (schema === undefined) return undefined as Output<S>;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as Output<S>;
  const errors: FieldError[] = parsed.error.issues.map((issue) => ({
    field: [location, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
  throw validationError('request.invalid', 'The request is invalid', { errors });
}

export function defineRoute<
  P extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
  R extends Schema | undefined = undefined,
  A extends AuthMode = 'required',
>(definition: RouteDefinition<P, Q, B, R, A>): Route {
  return {
    method: definition.method,
    path: definition.path,
    summary: definition.summary,
    tags: definition.tags ?? [],
    auth: definition.auth,
    rateLimit: definition.rateLimit,
    schemas: {
      params: definition.params,
      query: definition.query,
      body: definition.body,
      response: definition.success.schema,
    },
    successStatus: definition.success.status,
    async execute(request, reply, principal) {
      const result = await definition.handler({
        params: parseWith(definition.params as P, request.params, 'params'),
        query: parseWith(definition.query as Q, request.query, 'query'),
        body: parseWith(definition.body as B, request.body, 'body'),
        principal: principal as PrincipalFor<A>,
        request,
        reply,
      });
      if (!result.ok) throw result.error;

      reply.code(definition.success.status);
      const responseSchema = definition.success.schema;
      if (responseSchema === undefined) {
        await reply.send();
        return;
      }
      // Safety net: everything leaving the service is parsed through the declared response
      // schema. Contract schemas are strict, so an undeclared field (for example a password
      // hash that slipped into a DTO) fails here with a 500 instead of reaching the client.
      await reply.send(responseSchema.parse(result.value));
    },
  };
}
