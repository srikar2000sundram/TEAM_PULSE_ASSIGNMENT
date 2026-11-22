import { problemDetailsSchema } from '@teampulse/contracts';
import type { z } from 'zod';

/** A failed API call, reduced to what the interface needs. `code` is stable; `detail` is for people. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: readonly { field: string; message: string }[] = [],
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Where the HTTP layer gets the access token, and how it asks for a new one. */
export interface TokenSource {
  accessToken(): string | null;
  /** Exchanges the refresh cookie for a new access token. True when it worked. */
  refresh(): Promise<boolean>;
}

export interface RequestOptions<S extends z.ZodType | undefined> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path below the service, for example `/habits`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  /** The response is parsed with this schema; undefined means "no body expected". */
  readonly schema?: S;
  /** Sends the CSRF header the Identity cookie endpoints require. */
  readonly cookieAuth?: boolean;
}

export interface HttpClient {
  request<S extends z.ZodType | undefined = undefined>(
    options: RequestOptions<S>,
  ): Promise<S extends z.ZodType ? z.output<S> : undefined>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One service's HTTP client: bearer token, JSON, problem details turned into `ApiError`, and every
 * successful body checked against its contract schema (a drifted server fails loudly here instead of
 * showing broken data).
 *
 * On a 401 it asks the token source for a fresh token once and repeats the request; two
 * simultaneous 401s share one refresh.
 */
export class FetchHttpClient implements HttpClient {
  private refreshing: Promise<boolean> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenSource,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async request<S extends z.ZodType | undefined = undefined>(
    options: RequestOptions<S>,
  ): Promise<S extends z.ZodType ? z.output<S> : undefined> {
    let response = await this.send(options);
    if (
      response.status === 401 &&
      options.cookieAuth !== true &&
      this.tokens.accessToken() !== null
    ) {
      this.refreshing ??= this.tokens.refresh().finally(() => (this.refreshing = undefined));
      if (await this.refreshing) response = await this.send(options);
    }
    if (!response.ok) throw await toApiError(response);
    if (options.schema === undefined || response.status === 204) {
      return undefined as S extends z.ZodType ? z.output<S> : undefined;
    }
    const parsed = options.schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ApiError(502, 'response.invalid', 'The server sent an unexpected response');
    }
    return parsed.data as S extends z.ZodType ? z.output<S> : undefined;
  }

  private send(options: RequestOptions<z.ZodType | undefined>): Promise<Response> {
    const query = Object.entries(options.query ?? {})
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    const token = this.tokens.accessToken();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== null && options.cookieAuth !== true) headers['authorization'] = `Bearer ${token}`;
    if (options.cookieAuth === true) headers['x-requested-with'] = 'teampulse-web';
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return this.fetchFn(`${this.baseUrl}${options.path}${query === '' ? '' : `?${query}`}`, {
      method: options.method,
      headers,
      // The refresh cookie is only ever sent to the Identity auth paths.
      credentials: options.cookieAuth === true ? 'include' : 'same-origin',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const problem = problemDetailsSchema.parse(await response.json());
    return new ApiError(
      response.status,
      problem.code ?? 'error',
      problem.detail ?? problem.title,
      problem.errors ?? [],
      problem.correlationId,
    );
  } catch {
    return new ApiError(response.status, 'error', 'Something went wrong');
  }
}
