import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, FetchHttpClient, type TokenSource } from './http.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that answers from a queue of responses and records what it was asked. */
function fakeFetch(...answers: (Response | (() => Promise<Response>))[]) {
  const calls: Call[] = [];
  const fn = (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error('no more answers');
    return typeof next === 'function' ? next() : Promise.resolve(next);
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, code: string, extra: object = {}) =>
  json(
    { type: 'about:blank', title: 'Error', status, code, detail: `detail of ${code}`, ...extra },
    status,
  );

const tokens = (initial: string | null = 'token-1', refreshTo: string | null = 'token-2') => {
  let current = initial;
  let refreshes = 0;
  const source: TokenSource = {
    accessToken: () => current,
    refresh: () => {
      refreshes += 1;
      if (refreshTo === null) return Promise.resolve(false);
      current = refreshTo;
      return Promise.resolve(true);
    },
  };
  return { source, refreshes: () => refreshes };
};

const schema = z.object({ n: z.number() });
const headersOf = (call: Call) => call.init.headers as Record<string, string>;

describe('FetchHttpClient', () => {
  it('sends the bearer token and reads the response through the schema', async () => {
    const { fn, calls } = fakeFetch(json({ n: 7 }));
    const client = new FetchHttpClient('/api/v1/habit', tokens().source, fn);
    expect(await client.request({ method: 'GET', path: '/habits', schema })).toEqual({ n: 7 });
    expect(calls[0]?.url).toBe('/api/v1/habit/habits');
    expect(headersOf(calls[0]!)['authorization']).toBe('Bearer token-1');
  });

  it('encodes query parameters and leaves out undefined ones', async () => {
    const { fn, calls } = fakeFetch(json({ n: 1 }));
    await new FetchHttpClient('/x', tokens().source, fn).request({
      method: 'GET',
      path: '/a',
      query: { status: 'active', q: 'a b&c', skipped: undefined, n: 5 },
      schema,
    });
    expect(calls[0]?.url).toBe('/x/a?status=active&q=a%20b%26c&n=5');
  });

  it('sends a JSON body with the right content type', async () => {
    const { fn, calls } = fakeFetch(json({ n: 1 }));
    await new FetchHttpClient('/x', tokens().source, fn).request({
      method: 'POST',
      path: '/a',
      body: { hello: 'world' },
      schema,
    });
    expect(calls[0]?.init.body).toBe('{"hello":"world"}');
    expect(headersOf(calls[0]!)['content-type']).toBe('application/json');
  });

  it('turns a problem document into an ApiError with its stable code and field errors', async () => {
    const { fn } = fakeFetch(
      problem(400, 'request.invalid', {
        correlationId: 'c-1',
        errors: [{ field: 'body.title', message: 'Required' }],
      }),
    );
    const error = await new FetchHttpClient('/x', tokens().source, fn)
      .request({ method: 'POST', path: '/a', body: {}, schema })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'request.invalid',
      message: 'detail of request.invalid',
      correlationId: 'c-1',
      fieldErrors: [{ field: 'body.title', message: 'Required' }],
    });
  });

  it('copes with an error that is not a problem document (a proxy page, a network error body)', async () => {
    const { fn } = fakeFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await new FetchHttpClient('/x', tokens().source, fn)
      .request({ method: 'GET', path: '/a', schema })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'error', message: 'Something went wrong' });
  });

  it('refuses a response that does not match its contract, instead of showing broken data', async () => {
    const { fn } = fakeFetch(json({ n: 'seven' }));
    const error = await new FetchHttpClient('/x', tokens().source, fn)
      .request({ method: 'GET', path: '/a', schema })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'response.invalid' });
  });

  it('returns nothing for a 204', async () => {
    const { fn } = fakeFetch(new Response(null, { status: 204 }));
    expect(
      await new FetchHttpClient('/x', tokens().source, fn).request({ method: 'POST', path: '/a' }),
    ).toBeUndefined();
  });

  describe('expired access tokens', () => {
    it('refreshes once and repeats the request with the new token', async () => {
      const t = tokens();
      const { fn, calls } = fakeFetch(problem(401, 'auth.invalid_token'), json({ n: 2 }));
      const result = await new FetchHttpClient('/x', t.source, fn).request({
        method: 'GET',
        path: '/a',
        schema,
      });
      expect(result).toEqual({ n: 2 });
      expect(t.refreshes()).toBe(1);
      expect(headersOf(calls[0]!)['authorization']).toBe('Bearer token-1');
      expect(headersOf(calls[1]!)['authorization']).toBe('Bearer token-2');
    });

    it('shares one refresh between simultaneous 401s', async () => {
      const t = tokens();
      const { fn } = fakeFetch(
        problem(401, 'auth.invalid_token'),
        problem(401, 'auth.invalid_token'),
        json({ n: 1 }),
        json({ n: 2 }),
      );
      const client = new FetchHttpClient('/x', t.source, fn);
      await Promise.all([
        client.request({ method: 'GET', path: '/a', schema }),
        client.request({ method: 'GET', path: '/b', schema }),
      ]);
      expect(t.refreshes()).toBe(1);
    });

    it('gives up with the 401 when the refresh fails, and does not loop', async () => {
      const t = tokens('token-1', null);
      const { fn, calls } = fakeFetch(problem(401, 'auth.invalid_token'));
      const error = await new FetchHttpClient('/x', t.source, fn)
        .request({ method: 'GET', path: '/a', schema })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 401 });
      expect(calls).toHaveLength(1);
      expect(t.refreshes()).toBe(1);
    });

    it('does not retry forever when the new token is rejected too', async () => {
      const t = tokens();
      const { fn, calls } = fakeFetch(
        problem(401, 'auth.invalid_token'),
        problem(401, 'auth.invalid_token'),
      );
      const error = await new FetchHttpClient('/x', t.source, fn)
        .request({ method: 'GET', path: '/a', schema })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 401 });
      expect(calls).toHaveLength(2);
    });

    it('does not try to refresh when there is no token (a 401 from login, for example)', async () => {
      const t = tokens(null);
      const { fn } = fakeFetch(problem(401, 'auth.invalid_credentials'));
      const error = await new FetchHttpClient('/x', t.source, fn)
        .request({ method: 'GET', path: '/a', schema })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'auth.invalid_credentials' });
      expect(t.refreshes()).toBe(0);
    });
  });

  describe('cookie endpoints (login, refresh, logout)', () => {
    it('send the CSRF header and the cookie, never the bearer token, and never trigger a refresh', async () => {
      const t = tokens();
      const { fn, calls } = fakeFetch(problem(401, 'auth.invalid_token'));
      await new FetchHttpClient('/x', t.source, fn)
        .request({ method: 'POST', path: '/auth/refresh', cookieAuth: true, schema })
        .catch(() => undefined);
      expect(headersOf(calls[0]!)['x-requested-with']).toBe('teampulse-web');
      expect(headersOf(calls[0]!)['authorization']).toBeUndefined();
      expect(calls[0]?.init.credentials).toBe('include');
      expect(t.refreshes()).toBe(0);
    });

    it('keeps the cookie away from every other request', async () => {
      const { fn, calls } = fakeFetch(json({ n: 1 }));
      await new FetchHttpClient('/x', tokens().source, fn).request({
        method: 'GET',
        path: '/a',
        schema,
      });
      expect(calls[0]?.init.credentials).toBe('same-origin');
      expect(headersOf(calls[0]!)['x-requested-with']).toBeUndefined();
    });
  });
});
